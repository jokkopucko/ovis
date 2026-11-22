import { afterAll, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import { CODE_TTL_MS, DeviceGoneError, DeviceStore, handleDeviceRequest, newStreamKey, normalizeLabel, PAIRING_LINK_MS, PairingFinishingError, PairingRateLimitedError, PcInAccountError, readDeviceRegistry, sameBrowser, streamCookie, streamKeys } from "./devices.ts";
import { TestClock } from "./relay/test-helpers.ts";
import { privateStateFs, privateStateRefusal } from "./private-state.ts";
import { SafetyLog } from "./account/safety-log.ts";
import { RevokeAllIntent } from "./account/revoke-all-intent.ts";
import { isTaggedNode, parseTailscaleOwner } from "./tailscale.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-devices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function relayKeys() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { ...keys, publicKeySpki: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url") };
}

async function relaySignature(key: CryptoKey, nonce: Uint8Array, serverId = "server-a"): Promise<string> {
  return Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
    Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]))).toString("base64url");
}

describe("regression: a registry another account could write", () => {
  const root = mkdtempSync(join(tmpdir(), "devices-untrusted-"));
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  const registry = JSON.stringify({ gate_closed_at: null, devices: [{ id: "planted", token_hash: "x".repeat(64), role: "drive", label: "Planted", created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null }] });
  const mode = (path: string) => statSync(path).mode & 0o777;
  const someoneElse = (process.getuid?.() ?? 0) + 1;

  it.skipIf(process.platform === "win32")("is refused when another account owns it, its folder or the link to it", () => {
    const dir = mkdtempSync(join(root, "theirs-"));
    writeFileSync(join(dir, "devices.json"), registry, { mode: 0o600 });
    // as another account sees what it made: owned by it
    expect(privateStateRefusal(join(dir, "devices.json"), process.platform, someoneElse)).toContain("owned by uid");
    expect(privateStateRefusal(join(dir, "missing.json"), process.platform, someoneElse)).toContain("owned by uid");
    const linked = mkdtempSync(join(root, "linked-"));
    symlinkSync(join(dir, "devices.json"), join(linked, "devices.json"));
    expect(privateStateRefusal(join(linked, "devices.json"), process.platform, someoneElse)).toContain("owned by uid");
    expect(privateStateRefusal(join(dir, "devices.json"))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("takes others' write access away from what is this user's before reading it, and keeps working", () => {
    const dir = mkdtempSync(join(root, "open-"));
    chmodSync(dir, 0o757);
    writeFileSync(join(dir, "devices.json"), registry, { mode: 0o600 });
    chmodSync(join(dir, "devices.json"), 0o646);
    const store = new DeviceStore(dir);
    expect(store.error).toBeNull();
    expect(store.gated).toBe(true);
    expect(mode(dir)).toBe(0o755);
    expect(mode(join(dir, "devices.json"))).toBe(0o644);
    // through a link of this user's, the target's folder and file are held to the same rule
    const elsewhere = mkdtempSync(join(root, "elsewhere-"));
    chmodSync(elsewhere, 0o757);
    writeFileSync(join(elsewhere, "devices.json"), registry, { mode: 0o600 });
    chmodSync(join(elsewhere, "devices.json"), 0o666);
    const linked = mkdtempSync(join(root, "mine-linked-"));
    symlinkSync(join(elsewhere, "devices.json"), join(linked, "devices.json"));
    expect(readDeviceRegistry(join(linked, "devices.json")).kind).toBe("ok");
    expect(mode(elsewhere)).toBe(0o755);
    expect(mode(join(elsewhere, "devices.json"))).toBe(0o644);
    // a first installation in a folder others could write is one no longer
    const fresh = mkdtempSync(join(root, "fresh-"));
    chmodSync(fresh, 0o777);
    expect(new DeviceStore(fresh).gated).toBe(false);
    expect(mode(fresh)).toBe(0o755);
  });
});

it("flag off: canDrive finds a non-held drive row after a watch row with the same id", () => {
  const root = mkdtempSync(join(dir, "duplicate-id-"));
  const watch = { id: "0011223344556677", label: "Phone", role: "watch", token_hash: "a".repeat(64), created_at: "2026-10-10", last_seen_at: null };
  writeFileSync(join(root, "devices.json"), JSON.stringify({ gate_closed_at: watch.created_at,
    devices: [watch, { ...watch, role: "drive", token_hash: "b".repeat(64) }] }), { mode: 0o600 });
  const store = new DeviceStore(root);
  expect(store.error).toBeNull();
  expect(store.canDrive(watch.id)).toBe(true);
});

it("flag off: reading a PC-confirmed row leaves its carried notice on disk", () => {
  const root = mkdtempSync(join(dir, "carried-notice-"));
  const path = join(root, "devices.json");
  const at = "2026-10-01T00:00:00.000Z";
  const row = { id: "0011223344556677", label: "Phone", role: "watch", token_hash: "a".repeat(64),
    created_at: at, last_seen_at: null, carried_notice: "b".repeat(32),
    origin: { from: "pc", how: "confirmed", by: null, admit_no: 1, at } };
  const bytes = JSON.stringify({ gate_closed_at: at, devices: [row] });
  writeFileSync(path, bytes, { mode: 0o600 });
  expect(new DeviceStore(root).sessionRow(row.id)?.role).toBe("watch");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

describe("the gate closing", () => {
  it("Step 1 confirms the first local pairing when only the account subsystem is unavailable", () => {
    const root = mkdtempSync(join(dir, "off-first-local-"));
    const store = new DeviceStore(root, null, "Account state unavailable");
    expect(store.opensAll()).toBe(false);
    expect(store.failsClosed).toBe(false);
    const paired = store.pair(store.startPairing().code, "Local browser", "drive");
    if (!paired) throw new Error("Local Step 1 pairing failed");
    expect(store.match(paired.token)?.id).toBe(paired.device.id);
    expect(store.gated).toBe(true);
  });

  it("Step 1 confirms a fresh browser cookie without consuming a Step 2 listed-only removal", () => {
    const root = mkdtempSync(join(dir, "off-listed-intent-"));
    const intent = new RevokeAllIntent(root, []);
    intent.begin([], new Date().toISOString(), 1, 2);
    intent.awaitListed();
    const path = join(root, "revoke-all.json");
    const pending = readFileSync(path, "utf8");
    const store = new DeviceStore(root);
    expect(store.opensAll()).toBe(false);
    const paired = store.pair(store.startPairing().code, "Local browser", "drive");
    if (!paired) throw new Error("Local Step 1 pairing failed");
    expect(store.gated).toBe(false);
    expect(store.match(paired.token)?.id).toBe(paired.device.id);
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).match(paired.token)?.id).toBe(paired.device.id);
    expect(readFileSync(path, "utf8")).toBe(pending);
  });

  it("is told once, when the first device's cookie came back or the relay closed it, never for a later device or a revoke", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "gate-closed-")));
    let told = 0;
    const stop = store.onGateClosed(() => { told++; });
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    // an unconfirmed first pairing closes nothing: a cookie that never came back must not lock the LAN out
    expect([store.gated, told]).toEqual([false, 0]);
    const seen: boolean[] = [];
    store.onGateClosed(() => { throw new Error("a teardown that failed"); });
    store.onGateClosed(() => { seen.push(store.gated); });
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(store.match(phone.token)).toMatchObject({ id: phone.device.id });
      expect([store.gated, told]).toEqual([true, 0]);
      await Promise.resolve();
      expect([told, seen, warned.mock.calls.length]).toEqual([1, [true], 1]);
    } finally { warned.mockRestore(); }
    const tablet = store.pair(store.startPairing().code, "Tablet", "drive")!;
    store.match(tablet.token);
    store.revokeAll();
    store.closeGate();
    await Promise.resolve();
    expect(told).toBe(1);
    stop();
    let ended = 0;
    store.endWithGate(() => { ended++; })();
    expect(ended).toBe(1);
    const relayed = new DeviceStore(mkdtempSync(join(dir, "gate-closed-relay-")));
    let closed = 0, unheard = 0;
    relayed.onGateClosed(() => { closed++; });
    relayed.onGateClosed(() => { unheard++; })();
    let later = 0;
    const stopLater = relayed.endWithGate(() => { later++; });
    expect(later).toBe(0);
    relayed.closeGate();
    await Promise.resolve();
    expect([relayed.gated, closed, unheard, later]).toEqual([true, 1, 0, 1]);
    stopLater();
  });
});

describe("a code started while the gate was open", () => {
  it("ends when the first device's cookie closes the gate, and whoever shows it is told", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "gate-voids-code-")));
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    const stranger = store.startPairing(Date.now(), { remote: false, startedBy: null, memberRequired: false, open: true }).code;
    let told = 0;
    const stop = store.onPairingStarted(() => { told++; });
    store.match(phone.token);
    expect([store.gated, told]).toEqual([true, 1]);
    // that code admits whoever holds it: it does not outlive the gate it was started under
    expect(store.pair(stranger, "Stranger", "drive")).toBeNull();
    expect(store.list(null).map((device) => device.label)).toEqual(["Phone"]);
    const tablet = store.startPairing().code;
    store.match(phone.token);
    expect(store.pair(tablet, "Tablet", "drive")).not.toBeNull();
    expect(told).toBe(2);
    stop();
    // one this PC itself started under the open gate stays: the request that brings the first cookie back may
    // be the one that redeems it
    const own = new DeviceStore(mkdtempSync(join(dir, "gate-keeps-own-code-")));
    const first = own.pair(own.startPairing().code, "Phone", "drive")!;
    const second = own.startPairing().code;
    own.match(first.token);
    expect([own.gated, own.pair(second, "Tablet", "drive") !== null]).toEqual([true, true]);
  });
});

describe("ending a pairing", () => {
  it("leaves no six-digit code to redeem and ends a typed code bound to it", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "pair-end-")));
    const { code } = store.startPairing();
    let ended = 0;
    store.onPairingStarted(() => { ended++; });
    store.endPairing();
    expect(ended).toBe(1);
    expect(store.activePairing()).toBeNull();
    expect(store.pair(code, "Too late", "drive")).toBeNull();
  });
});

describe("relay device", () => {
  it("loads as kind ok and closes an ungated store with one durable write before announcing", async () => {
    const root = mkdtempSync(join(dir, "relay-first-"));
    const store = new DeviceStore(root);
    const candidate = store.pair(store.startPairing().code, "Cookie candidate", "drive");
    if (!candidate) throw new Error("Expected cookie candidate");
    const keys = await relayKeys();
    const notices: DevicePairedEvent[] = [];
    store.onPaired((event) => {
      expect(new DeviceStore(root).gated).toBe(true);
      expect(store.match(candidate.token)).toBeNull();
      notices.push(event);
    });
    const rename = spyOn(privateStateFs, "renameSync");
    let paired: ReturnType<DeviceStore["pairRelay"]>;
    try {
      paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki);
      expect(rename).toHaveBeenCalledTimes(1);
    } finally { rename.mockRestore(); }
    if (!paired) throw new Error("Expected relay pairing");
    expect(Object.keys(paired)).toEqual(["device"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.device_id).toBe(paired.device.id);
    const registry = readDeviceRegistry(join(root, "devices.json"));
    expect(registry.kind).toBe("ok");
    if (registry.kind !== "ok") throw new Error("Expected readable registry");
    expect(registry.devices[0]?.relay_public_key).toBe(keys.publicKeySpki);
    expect(registry.devices[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.devices[0]).not.toHaveProperty("private_key");
    const fresh = new DeviceStore(root);
    expect(fresh.list(paired.device.id)).toEqual([expect.objectContaining({ id: paired.device.id, via_relay: true, current: true })]);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    expect(await fresh.matchRelay(paired.device.id, nonce, await relaySignature(keys.privateKey, nonce), "server-a")).toEqual(paired.device);
    expect(fresh.match(keys.publicKeySpki)).toBeNull();
    expect(store.pairRelay(store.startPairing().code, "Again", keys.publicKeySpki)).not.toBeNull();
    expect(notices).toHaveLength(2);
  });

  it("does not publish a device or close the gate when persistence fails", async () => {
    const root = mkdtempSync(join(dir, "relay-write-failure-"));
    const store = new DeviceStore(root);
    const keys = await relayKeys();
    const code = store.startPairing().code;
    const notices: DevicePairedEvent[] = [];
    store.onPaired((event) => notices.push(event));
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw new Error("EIO"); });
    try {
      expect(() => store.pairRelay(code, "Phone", keys.publicKeySpki)).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(false);
    expect(notices).toEqual([]);
    expect(store.pairRelay(code, "Retry", keys.publicKeySpki)).not.toBeNull();
  });

  for (const invalid of ["nonce", "server_id", "other key", "short nonce", "long nonce", "bad signature", "short signature", "padded signature", "unknown device"] as const) {
    it(`rejects authentication with ${invalid}`, async () => {
      const store = new DeviceStore(mkdtempSync(join(dir, "relay-auth-")));
      const keys = await relayKeys();
      const paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki);
      if (!paired) throw new Error("Expected relay pairing");
      const nonce = new Uint8Array(32).fill(7);
      const key = invalid === "other key" ? (await relayKeys()).privateKey : keys.privateKey;
      const signature = await relaySignature(key, nonce);
      const suppliedNonce = invalid === "nonce" ? new Uint8Array(32).fill(8)
        : invalid === "short nonce" ? new Uint8Array(31) : invalid === "long nonce" ? new Uint8Array(33) : nonce;
      const suppliedSignature = invalid === "bad signature" ? "!".repeat(86)
        : invalid === "short signature" ? signature.slice(0, -1) : invalid === "padded signature" ? `${signature}==` : signature;
      expect(await store.matchRelay(invalid === "unknown device" ? "unknown" : paired.device.id, suppliedNonce, suppliedSignature,
        invalid === "server_id" ? "server-b" : "server-a")).toBeNull();
    });
  }

  it("rejects a signature over the nonce without the server identity", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-server-binding-")));
    const keys = await relayKeys();
    const paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki);
    if (!paired) throw new Error("Expected relay pairing");
    const nonce = new Uint8Array(32).fill(3);
    expect(await store.matchRelay(paired.device.id, nonce, await relaySignature(keys.privateKey, nonce, ""), "server-a")).toBeNull();
  });

  it("rejects a revoked device and keeps revoke-all gated after restart", async () => {
    const root = mkdtempSync(join(dir, "relay-revoked-"));
    const store = new DeviceStore(root);
    const keys = await relayKeys();
    const first = store.pairRelay(store.startPairing().code, "First", keys.publicKeySpki);
    const second = store.pairRelay(store.startPairing().code, "Second", keys.publicKeySpki);
    if (!first || !second) throw new Error("Expected relay pairings");
    const nonce = new Uint8Array(32).fill(1);
    const signature = await relaySignature(keys.privateKey, nonce);
    store.revoke(first.device.id);
    expect(await store.matchRelay(first.device.id, nonce, signature, "server-a")).toBeNull();
    // the second pairing holds the key just revoked, so it went too
    expect(store.has(second.device.id)).toBe(false);
    expect(store.revokeAll()).toEqual([]);
    expect(store.gated).toBe(true);
    const fresh = new DeviceStore(root);
    expect(fresh.gated).toBe(true);
    expect(fresh.list(null)).toEqual([]);
    expect(await fresh.matchRelay(second.device.id, nonce, signature, "server-a")).toBeNull();
  });

  for (const action of ["revoke", "update"] as const) {
    it(`does not return stale authority when ${action} races verification`, async () => {
      const store = new DeviceStore(mkdtempSync(join(dir, "relay-race-")));
      const keys = await relayKeys();
      const paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki);
      if (!paired) throw new Error("Expected relay pairing");
      const nonce = new Uint8Array(32).fill(1);
      const signature = await relaySignature(keys.privateKey, nonce);
      const verify = crypto.subtle.verify.bind(crypto.subtle);
      const during = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
        if (action === "revoke") store.revoke(paired.device.id);
        else store.update(paired.device.id, { role: "watch" });
        return verify(...args);
      });
      try {
        expect(await store.matchRelay(paired.device.id, nonce, signature, "server-a")).toBeNull();
      } finally { during.mockRestore(); }
    });
  }

  it("announces updates only after durability and authenticates the stored role", async () => {
    const root = mkdtempSync(join(dir, "relay-role-"));
    const store = new DeviceStore(root);
    const keys = await relayKeys();
    const paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki);
    if (!paired) throw new Error("Expected relay pairing");
    let closed = 0;
    store.onRevoke(paired.device.id, () => {
      expect(new DeviceStore(root).list(null)[0]?.role).toBe("watch");
      closed++;
    });
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw new Error("EIO"); });
    try {
      expect(() => store.update(paired.device.id, { role: "watch" })).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(closed).toBe(0);
    store.update(paired.device.id, { role: "watch" });
    expect(closed).toBe(1);
    store.onRevoke(paired.device.id, () => { closed++; });
    store.update(paired.device.id, { label: "Renamed" });
    expect(closed).toBe(1);
    const nonce = new Uint8Array(32).fill(2);
    expect(await store.matchRelay(paired.device.id, nonce, await relaySignature(keys.privateKey, nonce), "server-a"))
      .toEqual({ id: paired.device.id, label: "Renamed", role: "watch" });
    store.revoke(paired.device.id);
    expect(closed).toBe(2);
  });

  it("keeps relay authority when a rename races key verification", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-rename-race-")));
    const keys = await relayKeys();
    const paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki);
    if (!paired) throw new Error("Expected relay pairing");
    const nonce = new Uint8Array(32).fill(3);
    const signature = await relaySignature(keys.privateKey, nonce);
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    const during = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      store.update(paired.device.id, { label: "Renamed" });
      return verify(...args);
    });
    try {
      expect(await store.matchRelay(paired.device.id, nonce, signature, "server-a"))
        .toEqual({ id: paired.device.id, label: "Renamed", role: "drive" });
    } finally { during.mockRestore(); }
  });

  for (const lastAttempt of ["cookie", "relay"] as const) {
    it(`shares five guesses when the last attempt comes from ${lastAttempt}`, async () => {
      const store = new DeviceStore(mkdtempSync(join(dir, "relay-attempts-")));
      const keys = await relayKeys();
      const code = store.startPairing().code;
      const wrong = code === "999999" ? "000000" : "999999";
      for (let attempt = 0; attempt < 4; attempt++) {
        expect(attempt % 2 === 0 ? store.pair(wrong, "Phone", "drive") : store.pairRelay(wrong, "Phone", keys.publicKeySpki)).toBeNull();
      }
      expect(lastAttempt === "cookie" ? store.pair(wrong, "Phone", "drive") : store.pairRelay(wrong, "Phone", keys.publicKeySpki)).toBeNull();
      expect(store.pairRelay(code, "Phone", keys.publicKeySpki)).toBeNull();
      expect(store.pair(code, "Phone", "drive")).toBeNull();
    });
  }

  it("expires relay pairing codes without enrolling a device", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-expiry-")));
    const keys = await relayKeys();
    const code = store.startPairing(1000).code;
    expect(store.pairRelay(code, "Late", keys.publicKeySpki, 601001)).toBeNull();
    expect(store.gated).toBe(false);
  });

  it("rejects malformed public keys and fails closed on malformed registry entries", async () => {
    const keys = await relayKeys();
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
    const invalidKeys = ["", "not-spki", `${keys.publicKeySpki}=`, 42, null, {},
      Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64url"),
      Buffer.from(await crypto.subtle.exportKey("spki", other.publicKey)).toString("base64url")];
    for (const relay_public_key of invalidKeys) {
      const root = mkdtempSync(join(dir, "relay-invalid-"));
      const store = new DeviceStore(root);
      if (typeof relay_public_key === "string") {
        expect(store.pairRelay(store.startPairing().code, "Bad", relay_public_key)).toBeNull();
        expect(store.gated).toBe(false);
      }
      const path = join(root, "devices.json");
      const contents = JSON.stringify({ gate_closed_at: null, devices: [{
        id: "0123456789abcdef", label: "Bad", role: "drive", token_hash: "hash",
        created_at: new Date(0).toISOString(), last_seen_at: null, relay_public_key,
      }] });
      writeFileSync(path, contents);
      expect(readDeviceRegistry(path)).toEqual({ kind: "bad" });
      const fresh = new DeviceStore(root);
      expect(fresh.gated).toBe(true);
      expect(() => fresh.startPairing()).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
  });

  it("flag off: malformed hold metadata leaves the registry readable but held rows unadmitted", () => {
    const root = mkdtempSync(join(dir, "rollback-registry-"));
    const path = join(root, "devices.json");
    const live = { id: "notice", label: "Phone", role: "watch", token_hash: "a".repeat(64),
      created_at: new Date(0).toISOString(), last_seen_at: null, carried_notice: { old: true } };
    const held = [null, false, "", {}, "invalid"].map((value, index) => ({ ...live, id: `held-${index}`, held: value }));
    const bytes = JSON.stringify({ gate_closed_at: null, devices: [live, ...held] });
    writeFileSync(path, bytes, { mode: 0o600 });
    const rollback = new DeviceStore(root);
    expect(rollback.error).toBeNull();
    expect(rollback.sessionRow(live.id)?.role).toBe("watch");
    expect(rollback.list(null).map(row => row.id)).toEqual([live.id, ...held.map(row => row.id)]);
    for (const row of held) expect(rollback.sessionRow(row.id)).toBeNull();
    expect(new DeviceStore(root, null, null, { safety: SafetyLog.open(root) }).error).not.toBeNull();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("limits code issues to ten in a sliding window without extending refusals", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-issue-limit-")));
    for (let i = 0; i < 10; i++) store.startPairing(1000 + i);
    for (const now of [1010, 300000, 600999]) expect(() => store.startPairing(now)).toThrow(PairingRateLimitedError);
    expect(store.startPairing(601000).code).toMatch(/^\d{6}$/);
    expect(() => store.startPairing(601000)).toThrow(PairingRateLimitedError);
  });

  it("holds all relay PAIR requests for ten minutes after twenty failures without extending the hold", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-global-limit-")));
    const keys = await relayKeys();
    const code = store.startPairing(1000).code;
    for (let i = 0; i < 20; i++) expect(store.pairRelay("wrong", `Phone ${i}`, keys.publicKeySpki, 1000 + i)).toBeNull();
    for (const now of [1020, 300000, 601018]) {
      expect(() => store.pairRelay(code, "Blocked", keys.publicKeySpki, now)).toThrow(PairingRateLimitedError);
    }
    const freshCode = store.startPairing(601019).code;
    expect(store.pairRelay(freshCode, "Recovered", keys.publicKeySpki, 601019)).not.toBeNull();
  });

  it("does not count failures outside the sliding window or reset the budget on code replacement", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-window-")));
    const keys = await relayKeys();
    for (let i = 0; i < 19; i++) expect(store.pairRelay("wrong", "Phone", keys.publicKeySpki, 1000)).toBeNull();
    store.startPairing(2000);
    expect(store.pairRelay("wrong", "Phone", keys.publicKeySpki, 601000)).toBeNull();
    const code = store.startPairing(601001).code;
    expect(store.pairRelay(code, "Phone", keys.publicKeySpki, 601001)).not.toBeNull();
  });

  it("asks admit only for a key this PC does not hold: a paired phone that pairs again is never refused", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "relay-admit-")));
    const known = await relayKeys();
    const stranger = await relayKeys();
    let asked = 0;
    const refuse = () => { asked++; return false; };
    expect(store.pairRelay(store.startPairing().code, "Phone", known.publicKeySpki)).not.toBeNull();
    // a key new to this PC is asked about, and a refusal makes no device and spends no code
    const code = store.startPairing().code;
    expect(store.pairRelay(code, "Stranger", stranger.publicKeySpki, undefined, refuse)).toBeNull();
    expect(asked).toBe(1);
    expect(store.list(null)).toHaveLength(1);
    expect(store.pairRelay(code, "Phone again", known.publicKeySpki, undefined, refuse)).not.toBeNull();
    expect(asked).toBe(1);
    expect(store.list(null)).toHaveLength(2);
    expect(store.pairRelayApproved("Phone compared", known.publicKeySpki, { path: "code" }, undefined, refuse)).not.toBeNull();
    expect(asked).toBe(1);
    expect(store.pairRelayApproved("Stranger compared", stranger.publicKeySpki, { path: "code" }, undefined, refuse)).toBeNull();
    expect(asked).toBe(2);
    expect(store.list(null)).toHaveLength(3);
    for (const device of store.list(null)) store.revoke(device.id);
    expect(store.pairRelay(store.startPairing().code, "Phone", known.publicKeySpki, undefined, refuse)).toBeNull();
    expect(asked).toBe(3);
  });
});

describe("DeviceStore", () => {
  it("keeps an unreadable or invalid registry gated and intact for recovery", () => {
    for (const contents of ["{broken", "null", "{}", '{"devices":[]}', '{"gate_closed_at":null,"devices":[{}]}']) {
      const root = mkdtempSync(join(dir, "invalid-"));
      const path = join(root, "devices.json");
      writeFileSync(path, contents);
      const store = new DeviceStore(root);
      expect(store.gated).toBe(true);
      expect(store.error).toContain("Restore a valid devices.json");
      expect(() => store.startPairing()).toThrow();
      expect(() => store.revoke("any")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    const unreadable = mkdtempSync(join(dir, "unreadable-"));
    mkdirSync(join(unreadable, "devices.json"));
    expect(new DeviceStore(unreadable).gated).toBe(true);
    const fresh = new DeviceStore(mkdtempSync(join(dir, "fresh-")));
    expect(fresh.error).toBeNull();
    expect(fresh.gated).toBe(false);

    const legacy = mkdtempSync(join(dir, "legacy-gate-"));
    writeFileSync(join(legacy, "devices.json"), JSON.stringify({
      gate_closed_at: null,
      devices: [{ id: "0123456789abcdef", label: "Legacy", role: "drive", token_hash: "hash", created_at: new Date().toISOString(), last_seen_at: null }],
    }));
    const legacyStore = new DeviceStore(legacy);
    expect(legacyStore.gated).toBe(true);
    expect(legacyStore.list(null)[0]?.last_seen_at).toBeNull();
    expect(legacyStore.revoke("0123456789abcdef")).toBe(true);
    expect(legacyStore.gated).toBe(true);
    expect(new DeviceStore(legacy).gated).toBe(true);
  });

  it("closes only the revoked device's listeners, including late registrations", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "listeners-")));
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    expect(store.match(a.token)).not.toBeNull();
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    expect(store.match(b.token)).not.toBeNull();
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    const unsubscribe = store.onRevoke(a.device.id, () => closed.push("finished"));
    unsubscribe();
    store.revoke(a.device.id);
    store.onRevoke(a.device.id, () => closed.push("late upgrade"));
    expect(closed).toEqual(["a", "late upgrade"]);
    expect(store.match(b.token)).not.toBeNull();
  });

  it("pairs with the code once, keeps only a hash, and finds the device by its token", () => {
    const store = new DeviceStore(dir);
    expect(store.gated).toBe(false);
    const { code } = store.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.pair("000000".replace(/./g, (c) => c === code[0] ? "1" : c), "x", "drive")).toBeNull();
    const paired = store.pair(code.slice(0, 3) + " " + code.slice(3), "My phone", "drive");
    expect(paired).not.toBeNull();
    expect(store.pair(code, "again", "drive")).toBeNull();
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(() => statSync(join(dir, "devices.json"))).toThrow();
    expect(new DeviceStore(dir).gated).toBe(false); // an unreturned cookie is not durable across restart
    expect(new DeviceStore(dir).match(paired!.token)).toBeNull();
    expect(store.match(paired!.token)).toEqual({ id: paired!.device.id, label: "My phone", role: "drive" });
    expect(store.gated).toBe(true);
    const file = readFileSync(join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(paired!.token);
    expect((statSync(join(dir, "devices.json")).mode & 0o777)).toBe(0o600);
    expect(new DeviceStore(dir).gated).toBe(true);
    expect(store.match("not-a-token")).toBeNull();
    expect(new DeviceStore(dir).match(paired!.token)?.label).toBe("My phone");
  });

  it("returns the active pairing without changing it", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "active-pairing-")));
    const pairing = store.startPairing(1000);
    expect(store.activePairing(1000)).toEqual(pairing);
    expect(store.activePairing(601000)).toEqual(pairing);
    expect(store.pair(pairing.code, "Phone", "drive", 1000)).not.toBeNull();
    expect(store.activePairing(1000)).toBeNull();
  });

  it("does not return expired or exhausted pairing codes", () => {
    const expired = new DeviceStore(mkdtempSync(join(dir, "expired-pairing-")));
    expired.startPairing(1000);
    expect(expired.activePairing(601001)).toBeNull();

    const exhausted = new DeviceStore(mkdtempSync(join(dir, "exhausted-pairing-")));
    const { code } = exhausted.startPairing(1000);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) expect(exhausted.pair(wrong, "Wrong", "drive", 1000)).toBeNull();
    expect(exhausted.activePairing(1000)).toBeNull();
  });

  it("expires a code after ten minutes and after five wrong tries", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "s-")));
    const started = Date.now();
    const { code } = store.startPairing(started);
    expect(store.pair(code, "late", "drive", started + 10 * 60_000 + 1)).toBeNull();
    const second = store.startPairing().code;
    for (let i = 0; i < 5; i++) expect(store.pair("999999" === second ? "000000" : "999999", "x", "drive")).toBeNull();
    expect(store.pair(second, "x", "drive")).toBeNull();
  });

  it("keeps a first-pair retry open, preserves issued candidates across replaced codes, and bounds them", () => {
    const root = mkdtempSync(join(dir, "retry-"));
    const store = new DeviceStore(root);
    const now = Date.now();
    const replaced = store.startPairing(now).code;
    const firstCode = store.startPairing(now + 1).code;
    expect(store.pair(replaced, "obsolete", "drive", now + 1)).toBeNull();
    const lost = store.pair(firstCode, "Lost cookie", "drive", now + 1)!;
    const retry = store.pair(store.startPairing(now + 2).code, "Retry", "drive", now + 2)!;
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(store.match(retry.token, now + 3)).toEqual(retry.device);
    expect(store.gated).toBe(true);
    expect(store.match(lost.token, now + 4)).toBeNull();
    expect(store.list(null)).toHaveLength(1);
    expect(store.revoke(retry.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(store.match(lost.token, now + 5)).toBeNull();
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(true);

    const bounded = new DeviceStore(mkdtempSync(join(dir, "bounded-")));
    const issued: { token: string; device: { id: string; label: string; role: "drive" | "watch" } }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const at = now + i * 2;
      issued.push(bounded.pair(bounded.startPairing(at).code, `Device ${i}`, "drive", at)!);
    }
    expect(bounded.match(issued[0]!.token, now + 20)).toBeNull();
    expect(bounded.gated).toBe(false);
    expect(bounded.list(null)).toEqual([]);
    expect(bounded.match(issued[8]!.token, now + 20)).not.toBeNull();
    expect(bounded.gated).toBe(true);
  });

  it("expires unconfirmed first-pair cookies and loses them on restart without closing the gate", () => {
    const root = mkdtempSync(join(dir, "candidate-expiry-"));
    const store = new DeviceStore(root);
    const started = Date.now();
    const paired = store.pair(store.startPairing(started).code, "Expired", "drive", started)!;
    expect(store.match(paired.token, started + 10 * 60_000 + 1)).toBeNull();
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(false);
  });

  it("renames, revokes, and marks the caller's device", () => {
    const root = mkdtempSync(join(dir, "r-"));
    const store = new DeviceStore(root);
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    store.match(a.token);
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    const reloaded = new DeviceStore(root);
    expect(reloaded.gated).toBe(true);
    expect(reloaded.list(null).find((device) => device.id === b.device.id)?.last_seen_at).toBeNull();
    store.match(b.token);
    expect(store.list(a.device.id).map((d) => [d.label, d.current])).toEqual([["A", true], ["B", false]]);
    expect(store.update(b.device.id, { label: "Bee" })?.label).toBe("Bee");
    expect(store.revoke(a.device.id)).toBe(true);
    expect(store.revoke(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)?.label).toBe("Bee");
    // revoking the last device does not reopen the gate, not even after a restart
    expect(store.revoke(b.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).gated).toBe(true);
  });
});

describe("revoking a device unless an account vouches for it", () => {
  const revoke = (store: DeviceStore, id: string, unless?: string) => handleDeviceRequest(new Request(`http://127.0.0.1/api/devices/${id}`, {
    method: "DELETE", headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", ...(unless === undefined ? {} : { "x-ovis-unless-account": unless }) },
  }), `/api/devices/${id}`, store, { level: "full", via: "local", role: "drive" }, null);

  it("leaves a device that linked itself to that account since the caller read the list, and removes any other", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "revoke-unless-")));
    const pair = async (label: string) => {
      const keys = await relayKeys();
      return { id: store.pairRelay(store.startPairing().code, label, keys.publicKeySpki)!.device.id, key: keys.publicKeySpki };
    };
    const own = await pair("Own phone");
    expect(store.linkAccountKey(own.id, own.key, own.key, "acct_1")).not.toBeNull();
    const kept = await revoke(store, own.id, "acct_1");
    expect([kept.status, await kept.json()]).toEqual([409, { error: { code: "account_member", message: "that device is a member of the account by now" } }]);
    expect(store.list(null).map((device) => device.id)).toEqual([own.id]);
    // a member of another account is vouched for by nobody the caller named, and one in no account by nobody at all
    expect((await revoke(store, own.id, "acct_2")).status).toBe(204);
    const stray = await pair("Stray");
    expect((await revoke(store, stray.id, "acct_1")).status).toBe(204);
    expect(store.list(null)).toEqual([]);
    const member = await pair("Member");
    store.linkAccountKey(member.id, member.key, member.key, "acct_1");
    expect((await revoke(store, member.id)).status).toBe(204);
    expect((await revoke(store, member.id, "acct_1")).status).toBe(404);
  });
});

describe("a key held by a member row and a pairing made on this PC", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const member = "m000000000000001";
  const twoRows = async () => {
    const root = mkdtempSync(join(dir, "same-key-"));
    const key = (await relayKeys()).publicKeySpki;
    writeFileSync(join(root, "devices.json"), JSON.stringify({
      gate_closed_at: ago(600_000),
      devices: [
        { id: "s000000000000001", label: "Signer", role: "drive", token_hash: "h1", relay_public_key: (await relayKeys()).publicKeySpki, created_at: ago(600_000), last_seen_at: null, account: "acct_1" },
        { id: member, label: "Member", role: "drive", token_hash: "h2", relay_public_key: key, created_at: ago(300_000), last_seen_at: null, account: "acct_1", added_by: "s000000000000001" },
      ],
    }));
    const store = new DeviceStore(root);
    const closed: string[] = [];
    store.onRevoke(member, () => closed.push(member));
    return { root, key, store, closed };
  };

  it("revoking the pairing ends the member row of that key too", async () => {
    const { root, key, store, closed } = await twoRows();
    const local = store.pairRelayApproved("Local", key, { path: "code" })!.device;
    const announced: string[] = [];
    store.onRemoved((event) => announced.push(event.device_id));
    expect(store.revoke(local.id)).toBe(true);
    expect([closed, store.sessionRow(member), store.has(member)]).toEqual([[member], null, false]);
    expect(announced.sort()).toEqual([local.id, member].sort());
    expect(new DeviceStore(root).has(member)).toBe(false);
  });

  it("the revoke route hands every row it took to the cleanup", async () => {
    const { key, store } = await twoRows();
    const local = store.pairRelayApproved("Local", key, { path: "code" })!.device;
    const cleaned: string[] = [];
    const path = `/api/devices/${local.id}`;
    const response = await handleDeviceRequest(new Request(`http://127.0.0.1${path}`, { method: "DELETE", headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1" } }),
      path, store, { level: "full", via: "local", role: "drive" }, null, (ids) => cleaned.push(...ids));
    expect(response.status).toBe(204);
    expect(cleaned.sort()).toEqual([local.id, member].sort());
  });

  it("a revoke unless the device is a member of an account leaves both rows when the key's other row is a member", async () => {
    const { key, store, closed } = await twoRows();
    const local = store.pairRelayApproved("Local", key, { path: "code" })!.device;
    const path = `/api/devices/${local.id}`;
    const response = await handleDeviceRequest(new Request(`http://127.0.0.1${path}`, { method: "DELETE", headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", "x-ovis-unless-account": "acct_1" } }),
      path, store, { level: "full", via: "local", role: "drive" }, null);
    expect(response.status).toBe(409);
    expect([store.has(local.id), store.has(member), closed, store.isTombstoned(key)]).toEqual([true, true, [], false]);
  });

  it("a revoke leaves a row of the key that its tombstone does not cover", async () => {
    const { key, store, closed } = await twoRows();
    const local = store.pairRelayApproved("Local", key, { path: "code" })!.device;
    const later = store.pairRelayApproved("Later", key, { path: "code" })!.device;
    let laterClosed = 0;
    store.onRevoke(later.id, () => { laterClosed++; });
    // a clock set back before the pairings: the tombstone is older than both, so it covers the member row alone
    setSystemTime(new Date(Date.now() - 3_600_000));
    try { expect(store.revoke(local.id)).toBe(true); } finally { setSystemTime(); }
    expect([store.has(local.id), store.has(member), store.has(later.id), closed, laterClosed]).toEqual([false, false, true, [member], 0]);
  });

  it("a revoke ends a pairing code that another row it took holds", async () => {
    const { key, store } = await twoRows();
    const local = store.pairRelayApproved("Local", key, { path: "code" })!.device;
    store.startPairing(Date.now(), { remote: true, startedBy: local.id, memberRequired: false, by: local.id });
    expect(store.activePairing()).not.toBeNull();
    expect(store.revoke(member)).toBe(true);
    expect([store.has(local.id), store.activePairing()]).toEqual([false, null]);
  });

  it("a remove signed before the pairing keeps the pairing and takes the member row", async () => {
    const { root, key, store, closed } = await twoRows();
    const issuedAt = ago(1000);
    const local = store.pairRelayApproved("Local again", key, { path: "code" })!.device;
    expect(store.removeAccountKey(key, "acct_1", { id: "rec_1", issuedAt })).toBe(true);
    expect([closed, store.has(member), store.has(local.id), store.accountSigner(key, "acct_1"), store.isTombstoned(key)]).toEqual([[member], false, true, null, false]);
    const restarted = new DeviceStore(root);
    expect([restarted.has(member), restarted.has(local.id)]).toEqual([false, true]);
    expect(store.removeAccountKey(key, "acct_1", { id: "rec_1", issuedAt })).toBe(false);
  });
});

describe("revoking a device that holds a pairing code", () => {
  const guard = { origin: "http://127.0.0.1", "x-herdr-machine": "1" };
  const call = (store: DeviceStore, method: string, path: string, access: Parameters<typeof handleDeviceRequest>[3], relayKey: string | null = null) =>
    handleDeviceRequest(new Request(`http://127.0.0.1${path}`, { method, headers: guard }), path, store, access, relayKey);
  const local = { level: "full", via: "local", role: "drive" } as const;

  it("ends the code that device started through the relay, so nobody pairs with it after the device is gone", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "revoke-code-relay-")));
    // let in by a code this PC showed, on a PC in no account: any driving relay device may start a code there
    const keys = await relayKeys();
    const stranger = store.pairRelay(store.startPairing().code, "Stranger", keys.publicKeySpki)!.device;
    let told = 0;
    store.onPairingStarted(() => { told++; });
    const started = await call(store, "POST", "/api/devices/pair/start", { level: "full", via: "relay", role: "drive", device: stranger }, keys.publicKeySpki);
    expect(started.status).toBe(200);
    const { code } = await started.json() as { code: string };
    expect(store.activePairing()?.code).toBe(code);
    expect((await call(store, "DELETE", `/api/devices/${stranger.id}`, local)).status).toBe(204);
    expect(store.activePairing()).toBeNull();
    expect(told).toBe(2);
    expect(store.pairRelay(code, "Stranger 2", (await relayKeys()).publicKeySpki)).toBeNull();
    expect(store.list(null)).toEqual([]);
  });

  it("ends the code a device paired at this PC's own address started, and leaves a code nobody revoked started", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "revoke-code-direct-")));
    const pairHere = (label: string) => {
      const paired = store.pair(store.startPairing().code, label, "drive")!;
      store.match(paired.token);
      return paired.device;
    };
    const laptop = pairHere("Laptop");
    const tablet = pairHere("Tablet");
    const started = await call(store, "POST", "/api/devices/pair/start", { level: "full", via: "device", role: "drive", device: laptop });
    const { code } = await started.json() as { code: string };
    expect((await call(store, "DELETE", `/api/devices/${tablet.id}`, local)).status).toBe(204);
    expect(store.activePairing()?.code).toBe(code);
    expect((await call(store, "DELETE", `/api/devices/${laptop.id}`, local)).status).toBe(204);
    expect(store.activePairing()).toBeNull();
    expect(store.pair(code, "Too late", "drive")).toBeNull();
    const phone = pairHere("Phone");
    const own = await (await call(store, "POST", "/api/devices/pair/start", local)).json() as { code: string };
    expect((await call(store, "DELETE", `/api/devices/${phone.id}`, local)).status).toBe(204);
    expect(store.activePairing()?.code).toBe(own.code);
  });

  it("starts no code for a device that is gone by then, and hands it none: no later revoke would end it", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "revoke-code-gone-")));
    const paired = store.pair(store.startPairing().code, "Laptop", "drive")!;
    store.match(paired.token);
    const laptop = paired.device;
    // revoked while its request was on its way (a relay round trip, a look-up of who asks)
    expect(store.revoke(laptop.id)).toBe(true);
    expect(() => store.startPairing(Date.now(), { remote: false, startedBy: null, memberRequired: false, by: laptop.id })).toThrow(DeviceGoneError);
    expect(() => store.startPairing(Date.now(), { remote: true, startedBy: laptop.id, memberRequired: false })).toThrow(DeviceGoneError);
    expect(store.activePairing()).toBeNull();
    const own = store.startPairing();
    expect(() => store.holdPairing(laptop.id)).toThrow(DeviceGoneError);
    const refused = await call(store, "POST", "/api/devices/pair/start", { level: "full", via: "device", role: "drive", device: laptop });
    expect([refused.status, await refused.json()]).toEqual([401, { error: { code: "unauthorized", message: "this device is no longer paired" } }]);
    expect(store.activePairing()?.code).toBe(own.code);
    for (let asked = 0; asked < 12; asked++) expect(() => store.startPairing(Date.now(), { remote: false, startedBy: null, memberRequired: false, by: laptop.id })).toThrow(DeviceGoneError);
    expect(store.startPairing().code).toMatch(/^\d{6}$/);
  });

  it("ends a code a device was handed, not only one it started", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "revoke-code-handed-")));
    const paired = store.pair(store.startPairing().code, "Laptop", "drive")!;
    store.match(paired.token);
    const own = store.startPairing();
    store.holdPairing(paired.device.id);
    expect(store.revoke(paired.device.id)).toBe(true);
    expect(store.activePairing()).toBeNull();
    expect(store.pair(own.code, "Too late", "drive")).toBeNull();
  });
});

// The relay tab's QR code (POST /api/relay/offer with x-ovis-no-account-only): whoever scans it signed in becomes the
// PC's first account member, so it is for a PC in no account only.
describe("how a device a code started through the relay let in joined its account", () => {
  /** A PC in no account, and the calls a relay device makes on it: start a code, pair with one, be revoked. */
  function setUp(name: string) {
    const stateDir = mkdtempSync(join(dir, name));
    const store = new DeviceStore(stateDir);
    const guard = { origin: "http://127.0.0.1", "x-herdr-machine": "1" };
    const start = async (device: { id: string; label: string; role: "drive" | "watch" }, key: string) => {
      const started = await handleDeviceRequest(new Request("http://127.0.0.1/api/devices/pair/start", { method: "POST", headers: guard }),
        "/api/devices/pair/start", store, { level: "full", via: "relay", role: "drive", device }, key);
      expect(started.status).toBe(200);
      return (await started.json() as { code: string }).code;
    };
    const paired = async (code: string, label: string) => {
      const keys = await relayKeys();
      return { device: store.pairRelay(code, label, keys.publicKeySpki)!.device, key: keys.publicKeySpki };
    };
    const stored = (id: string) => { const registry = readDeviceRegistry(join(stateDir, "devices.json")); return registry.kind === "ok" ? registry.devices.find((d) => d.id === id) : undefined; };
    const revoke = async (id: string) => expect((await handleDeviceRequest(new Request(`http://127.0.0.1/api/devices/${id}`, { method: "DELETE", headers: guard }),
      `/api/devices/${id}`, store, { level: "full", via: "local", role: "drive" }, null)).status).toBe(204);
    return { store, start, paired, stored, revoke };
  }

  it("on its own word when the code's starter was no account member, and with no mark when a member started the code", async () => {
    const { store, start, paired, stored } = setUp("joined-by-starter-");
    // on a PC in no account any driving relay device may start a code: its starter is named, and approves nothing
    const starter = await paired(store.startPairing().code, "Starter");
    const joined = await paired(await start(starter.device, starter.key), "Joined");
    expect(stored(joined.device.id)).toMatchObject({ added_by: starter.device.id });
    expect(stored(joined.device.id)).not.toHaveProperty("member_approved_in");
    store.linkAccountKey(joined.device.id, joined.key, joined.key, "acct_1");
    expect(stored(joined.device.id)?.joined_by).toBe("word");
    expect(store.accountRows()).toEqual({ members: 1, unlinked: [starter.device.id], own_word: [joined.device.id] });
    // a code a member starts is that member's approval: the device it lets in links with no mark
    const added = await paired(await start(joined.device, joined.key), "Added");
    expect(stored(added.device.id)).toMatchObject({ added_by: joined.device.id, member_approved_in: "acct_1" });
    store.linkAccountKey(added.device.id, added.key, added.key, "acct_1");
    expect(stored(added.device.id)).not.toHaveProperty("joined_by");
    expect(store.accountRows()).toEqual({ members: 2, unlinked: [starter.device.id], own_word: [joined.device.id] });
  });

  it("on its own word when the code's starter joined the account only after starting it", async () => {
    const { store, start, paired, stored } = setUp("joined-by-late-member-");
    const starter = await paired(store.startPairing().code, "Starter");
    const code = await start(starter.device, starter.key);
    // the starter becomes a member between starting the code and its use: that approves nothing it started before
    store.linkAccountKey(starter.device.id, starter.key, starter.key, "acct_1");
    const later = await paired(code, "Later");
    expect(stored(later.device.id)).toMatchObject({ added_by: starter.device.id });
    expect(stored(later.device.id)).not.toHaveProperty("member_approved_in");
    store.linkAccountKey(later.device.id, later.key, later.key, "acct_1");
    expect(stored(later.device.id)?.joined_by).toBe("word");
    expect(store.accountRows()).toEqual({ members: 2, unlinked: [], own_word: [starter.device.id, later.device.id] });
  });

  it("on its own word when it links into another account than the one whose member approved it", async () => {
    const { store, start, paired, stored, revoke } = setUp("joined-by-other-account-");
    const member = await paired(store.startPairing().code, "Member");
    store.linkAccountKey(member.device.id, member.key, member.key, "acct_1");
    const approved = await paired(await start(member.device, member.key), "Approved");
    expect(stored(approved.device.id)).toMatchObject({ added_by: member.device.id, member_approved_in: "acct_1" });
    // the member goes, the PC is in no account, and the device links into another one
    await revoke(member.device.id);
    expect(store.account()).toBeNull();
    store.linkAccountKey(approved.device.id, approved.key, approved.key, "acct_2");
    expect(stored(approved.device.id)?.joined_by).toBe("word");
    expect(store.accountRows()).toEqual({ members: 1, unlinked: [], own_word: [approved.device.id] });
  });
});

describe("a pairing code made only for a PC in no account", () => {
  const paired = async (store: DeviceStore, label: string) => {
    const key = (await relayKeys()).publicKeySpki;
    return { id: store.pairRelay(store.startPairing().code, label, key)!.device.id, key };
  };

  it("is not made on a PC in an account, and leaves the code pending there as it was", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-refused-")));
    const member = await paired(store, "Phone");
    expect(store.linkAccountKey(member.id, member.key, member.key, "acct_1")).not.toBeNull();
    const own = store.startPairing();
    let told = 0;
    store.onPairingStarted(() => { told++; });
    expect(() => store.pairingForNoAccount()).toThrow(PcInAccountError);
    expect([store.activePairing()?.code, told]).toEqual([own.code, 0]);
    for (let asked = 0; asked < 12; asked++) expect(() => store.pairingForNoAccount()).toThrow(PcInAccountError);
    expect(store.revoke(member.id)).toBe(true);
    expect(store.pairingForNoAccount().code).toMatch(/^\d{6}$/);
  });

  it("is a fresh code, never one another place started, and the same one when asked again", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-fresh-")));
    store.startPairing();
    let started = 0;
    store.onPairingStarted(() => { started++; });
    const qr = store.pairingForNoAccount();
    expect(started).toBe(1);
    expect(store.activePairing()).toEqual(qr);
    expect(store.pairingForNoAccount()).toEqual(qr);
    expect(started).toBe(1);
    store.startPairing();
    store.pairingForNoAccount();
    expect(started).toBe(3);
  });

  it("is held by the paired device that asked for it, and goes with it", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-held-")));
    const laptop = await paired(store, "Laptop");
    const qr = store.pairingForNoAccount(laptop.id);
    expect(store.revoke(laptop.id)).toBe(true);
    expect(store.activePairing()).toBeNull();
    expect(store.pairRelay(qr.code, "Too late", (await relayKeys()).publicKeySpki)).toBeNull();
    expect(() => store.pairingForNoAccount(laptop.id)).toThrow(DeviceGoneError);
  });

  it("ends when the PC joins an account another way, so nobody scans it into a PC that has members", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-joined-")));
    const laptop = await paired(store, "Laptop");
    const qr = store.pairingForNoAccount();
    let told = 0;
    store.onPairingStarted(() => { told++; });
    expect(store.linkAccountKey(laptop.id, laptop.key, laptop.key, "acct_1")).not.toBeNull();
    expect([store.activePairing(), told]).toEqual([null, 1]);
    expect(store.pairRelay(qr.code, "Stranger", (await relayKeys()).publicKeySpki)).toBeNull();
    expect(store.pair(qr.code, "Stranger", "drive")).toBeNull();
    expect(store.list(null).map((device) => device.label)).toEqual(["Laptop"]);
  });

  it("pairs nobody on a PC in an account even when it is still pending there", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-guard-")));
    const laptop = await paired(store, "Laptop");
    const qr = store.pairingForNoAccount();
    const pending: unknown = Reflect.get(store, "pending");
    expect(store.linkAccountKey(laptop.id, laptop.key, laptop.key, "acct_1")).not.toBeNull();
    // the end on join is one guard; the check at redeem is the other, should a code outlive the join
    Reflect.set(store, "pending", pending);
    expect(store.pairRelay(qr.code, "Stranger", (await relayKeys()).publicKeySpki)).toBeNull();
    expect(store.activePairing()).toBeNull();
    expect(store.list(null).map((device) => device.label)).toEqual(["Laptop"]);
  });

  it("lets the device that scans it in, which then makes the PC its account's", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-scanned-")));
    const key = (await relayKeys()).publicKeySpki;
    const phone = store.pairRelay(store.pairingForNoAccount().code, "Phone", key)!.device;
    expect(store.linkAccountKey(phone.id, key, key, "acct_1")).not.toBeNull();
    expect(store.account()).toBe("acct_1");
    expect(() => store.pairingForNoAccount()).toThrow(PcInAccountError);
  });

  it("is not replaced past its ten minutes while a device that paired with it in time may still link, and is once none may", async () => {
    for (const links of [true, false]) {
      const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-finishing-")));
      const clock = new TestClock();
      store.useClock(clock);
      const made = Date.now();
      const qr = store.pairingForNoAccount(null, made);
      const key = (await relayKeys()).publicKeySpki;
      const phone = store.pairRelay(qr.code, "Phone", key)!.device;
      clock.advance(5_000);
      // the QR code's ten minutes are over and the page asks for its next code: the phone has 25 s left to link
      let finishing: unknown;
      try { store.pairingForNoAccount(null, made + CODE_TTL_MS + 1); } catch (error) { finishing = error; }
      expect(finishing).toBeInstanceOf(PairingFinishingError);
      expect((finishing as PairingFinishingError).retryAfter).toBe(25);
      if (links) {
        expect(store.linkAccountKey(phone.id, key, key, "acct_1")).not.toBeNull();
        expect(() => store.pairingForNoAccount(null, made + CODE_TTL_MS + 2)).toThrow(PcInAccountError);
      } else {
        clock.advance(PAIRING_LINK_MS);
        const next = store.pairingForNoAccount(null, made + CODE_TTL_MS + 2);
        expect(next.code).toMatch(/^\d{6}$/);
        expect(store.activePairing(made + CODE_TTL_MS + 2)).toEqual(next);
      }
    }
  });

  it("keeps a device that links with a key this PC removed after a restart, also when the clock was set back and the removal could not be cleared", async () => {
    const stateDir = mkdtempSync(join(dir, "no-account-code-clock-back-"));
    const store = new DeviceStore(stateDir);
    const key = (await relayKeys()).publicKeySpki;
    const first = store.pairRelay(store.startPairing().code, "Phone", key)!.device;
    expect(store.revoke(first.id)).toBe(true);
    // the same phone pairs with the relay tab's code and links with the key it paired with
    const phone = store.pairRelay(store.pairingForNoAccount().code, "Phone", key)!.device;
    Reflect.set(store, "clearTombstone", () => { throw new Error("disk full"); });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    setSystemTime(new Date(Date.now() - 60_000));
    try { expect(store.linkAccountKey(phone.id, key, key, "acct_1")).not.toBeNull(); } finally { setSystemTime(); logged.mockRestore(); }
    const restarted = new DeviceStore(stateDir);
    expect(restarted.list(null).map((device) => device.id)).toEqual([phone.id]);
    expect(restarted.isTombstoned(key)).toBe(false);
  });

  it("leaves a code made any other way pending when the PC joins an account", async () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "no-account-code-other-")));
    const laptop = await paired(store, "Laptop");
    const own = store.startPairing();
    expect(store.linkAccountKey(laptop.id, laptop.key, laptop.key, "acct_1")).not.toBeNull();
    expect(store.activePairing()?.code).toBe(own.code);
  });
});

describe("revoke all", () => {
  it("revoke all is atomic and stays gated after restart", () => {
    const root = mkdtempSync(join(dir, "revoke-all-"));
    const store = new DeviceStore(root);
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    store.match(a.token);
    const b = store.pair(store.startPairing().code, "B", "watch")!;
    store.match(b.token);
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(a.device.id, () => closed.push("a2"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    expect(store.revokeAll().sort()).toEqual([a.device.id, b.device.id].sort());
    expect(closed.sort()).toEqual(["a", "a2", "b"]);
    expect(store.list(null)).toEqual([]);
    expect(store.has(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)).toBeNull();
    expect(store.gated).toBe(true);
    const registry = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: unknown[] };
    expect(registry).toEqual({ gate_closed_at: expect.any(String), devices: [] });
    const reloaded = new DeviceStore(root);
    expect(reloaded.gated).toBe(true);
    expect(reloaded.match(a.token)).toBeNull();
    store.onRevoke(a.device.id, () => closed.push("late"));
    expect(closed).toContain("late");
    expect(store.revokeAll()).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(true);
  });

  it("save failure preserves pending and live devices", () => {
    const root = mkdtempSync(join(dir, "revoke-all-failure-"));
    const store = new DeviceStore(root);
    const live = store.pair(store.startPairing().code, "Live", "drive")!;
    store.match(live.token);
    const pendingCode = store.startPairing().code;
    let closed = false;
    store.onRevoke(live.device.id, () => { closed = true; });
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => store.revokeAll()).toThrow("EIO");
      expect(closed).toBe(false);
      expect(store.list(null).map((d) => d.label)).toEqual(["Live"]);
      expect(store.match(live.token)?.label).toBe("Live");
    } finally { fsync.mockRestore(); }
    expect(new DeviceStore(root).match(live.token)?.label).toBe("Live");
    expect(store.pair(pendingCode, "Second", "drive")).not.toBeNull();
    expect(store.revokeAll()).toHaveLength(2);
    expect(closed).toBe(true);
  });

  it("unconfirmed credentials and pending codes are void", () => {
    const root = mkdtempSync(join(dir, "revoke-all-void-"));
    const store = new DeviceStore(root);
    const candidate = store.pair(store.startPairing().code, "Candidate", "drive")!;
    const code = store.startPairing().code;
    expect(store.gated).toBe(false);
    expect(store.revokeAll()).toEqual([]);
    // revoking closes the gate durably even though no device was ever confirmed
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).gated).toBe(true);
    expect(store.match(candidate.token)).toBeNull();
    expect(store.pair(code, "Stale code", "drive")).toBeNull();
    expect(store.list(null)).toEqual([]);
    const notices: string[] = [];
    store.onPaired((event) => notices.push(event.label));
    const fresh = store.pair(store.startPairing().code, "Fresh", "drive")!;
    expect(store.match(fresh.token)?.label).toBe("Fresh");
    expect(notices).toEqual(["Fresh"]);
  });

  it("notice occurs once after durable enrollment", () => {
    const root = mkdtempSync(join(dir, "paired-notice-"));
    const store = new DeviceStore(root);
    const events: DevicePairedEvent[] = [];
    const stop = store.onPaired((event) => events.push(event));
    const first = store.pair(store.startPairing().code, "  First   phone ", "drive")!;
    expect(events).toEqual([]);
    expect(store.match(first.token)).not.toBeNull();
    expect(store.match(first.token)).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "device-paired", event_id: expect.stringMatching(/^[0-9a-f]{16}$/), device_id: first.device.id, label: "  First   phone ", enrolled_at: expect.any(String) });
    expect(Date.parse(events[0]!.enrolled_at)).not.toBeNaN();
    const second = store.pair(store.startPairing().code, "Second", "drive")!;
    expect(events).toHaveLength(2);
    expect(events[1]!.device_id).toBe(second.device.id);
    expect(events[1]!.event_id).not.toBe(events[0]!.event_id);
    store.match(second.token, Date.now() + 120_000);
    store.update(second.device.id, { label: "Renamed" });
    expect(events).toHaveLength(2);
    const code = store.startPairing().code;
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try { expect(() => store.pair(code, "Failed", "drive")).toThrow("EIO"); } finally { fsync.mockRestore(); }
    expect(events).toHaveLength(2);
    stop();
    expect(store.pair(code, "Unheard", "drive")).not.toBeNull();
    expect(events).toHaveLength(2);
  });

  it("tells the moment of enrollment, not of issue, and the browser that asked for it", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "enrolled-at-")));
    const heard: { event: DevicePairedEvent; origin: readonly string[] }[] = [];
    store.onPaired((event, origin) => heard.push({ event, origin }));
    const issuedAt = Date.parse("2026-10-21T12:00:00.000Z");
    const confirmedAt = Date.parse("2026-10-21T12:05:00.000Z");
    const self = ["a".repeat(32), "b".repeat(32)];
    const first = store.pair(store.startPairing(issuedAt).code, "Phone", "drive", issuedAt, self)!;
    expect(heard).toEqual([]);
    expect(store.match(first.token, confirmedAt)).not.toBeNull();
    expect(heard).toEqual([{ event: expect.objectContaining({ device_id: first.device.id, enrolled_at: "2026-10-21T12:05:00.000Z" }), origin: self }]);
    const gatedAt = Date.parse("2026-10-21T12:07:30.000Z");
    const second = store.pair(store.startPairing(gatedAt).code, "Tablet", "drive", gatedAt)!;
    expect(heard[1]).toEqual({ event: expect.objectContaining({ device_id: second.device.id, enrolled_at: "2026-10-21T12:07:30.000Z" }), origin: [] });
  });

  it("reads every stream key a browser holds and ignores malformed ones", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    const keys = (cookie: string) => streamKeys(new Request("http://host/", { headers: { cookie } }));
    expect(keys(`ovis_stream_${a}=1; other=x; ovis_stream_${b}=1`)).toEqual([a, b]);
    expect(keys(`ovis_stream_${a}=0; ovis_stream_${"A".repeat(32)}=1; ovis_stream_abc=1; ovis_stream=${a}; =1; %zz; ovis_stream_${b}=1`)).toEqual([b]);
    expect(keys("")).toEqual([]);
    const many = Array.from({ length: 12 }, (_, index) => index.toString(16).repeat(32));
    expect(keys(many.map((key) => `ovis_stream_${key}=1`).join("; "))).toEqual(many.slice(0, 8));
    expect(sameBrowser([a, b], [b])).toBe(true);
    expect(sameBrowser([a], [b])).toBe(false);
    expect(sameBrowser([], [a])).toBe(false);
    // the cookie that issues one: its own name, no authority, a year like the device cookie
    expect(streamCookie(a, true)).toBe(`ovis_stream_${a}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure`);
    expect(streamCookie(a, false)).not.toContain("Secure");
    expect(newStreamKey()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("labels and owner", () => {
  it("trims labels and falls back", () => {
    expect(normalizeLabel("  my   phone ", "Device")).toBe("my phone");
    expect(normalizeLabel("", "Device")).toBe("Device");
    expect(normalizeLabel(42, "Device")).toBe("Device");
    expect(normalizeLabel("x".repeat(80), "Device")).toHaveLength(48);
  });

  it("reads the PC's login out of tailscale status", () => {
    const status = JSON.stringify({ Self: { UserID: 42 }, User: { "42": { LoginName: "me@example.com" }, "43": { LoginName: "them@example.com" } } });
    expect(parseTailscaleOwner(status)).toBe("me@example.com");
    expect(parseTailscaleOwner(JSON.stringify({ Self: { UserID: 99 }, User: {} }))).toBeNull();
    // a real id is past 2^53: as a double it becomes ...136 and names nobody (#526)
    expect(parseTailscaleOwner('{"Self":{"UserID":15633668397603135},"User":{"15633668397603135":{"LoginName":"me@example.com"}}}')).toBe("me@example.com");
    expect(parseTailscaleOwner(null)).toBeNull();
    expect(parseTailscaleOwner("nope")).toBeNull();
    expect(isTaggedNode(status)).toBeFalse();
    // a tagged node's user entry is the node itself: no person's login
    const tagged = JSON.stringify({ Self: { UserID: 7, Tags: ["tag:server"] }, User: { "7": { LoginName: "pc.tailnet.ts.net" } } });
    expect(parseTailscaleOwner(tagged)).toBeNull();
    expect(isTaggedNode(tagged)).toBeTrue();
    expect(isTaggedNode(null)).toBeFalse();
  });
});

it("reports failed registry writes without committing a pair, rename or revocation in memory", () => {
  const root = mkdtempSync(join(dir, "write-failure-"));
  const store = new DeviceStore(root);
  const first = store.pair(store.startPairing().code, "Original", "drive")!;
  store.match(first.token);
  let closed = false;
  store.onRevoke(first.device.id, () => { closed = true; });
  const code = store.startPairing().code;
  const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
  try {
    expect(() => store.pair(code, "Failed pair", "drive")).toThrow("EXDEV");
    expect(() => store.update(first.device.id, { label: "Failed rename" })).toThrow("EXDEV");
    expect(() => store.revoke(first.device.id)).toThrow("EXDEV");
  } finally { rename.mockRestore(); }
  expect(closed).toBe(false);
  expect(readdirSync(root)).toEqual(["devices.json"]);
  expect(store.list(null).map((d) => d.label)).toEqual(["Original"]);
  expect(store.match(first.token)?.label).toBe("Original");
  expect(new DeviceStore(root).match(first.token)?.label).toBe("Original");
  expect(store.pair(code, "Retry", "drive")).not.toBeNull();
  expect(store.revoke(first.device.id)).toBe(true);
  expect(closed).toBe(true);
  expect(new DeviceStore(root).match(first.token)).toBeNull();
});

it("does not authorize a first-pair cookie when promotion cannot be persisted", () => {
  const root = mkdtempSync(join(dir, "promotion-failure-"));
  const store = new DeviceStore(root);
  const candidate = store.pair(store.startPairing().code, "Pending", "drive")!;
  const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
  try {
    expect(() => store.match(candidate.token)).toThrow("EIO");
  } finally { fsync.mockRestore(); }
  expect(readdirSync(root)).toEqual([]);
  expect(store.gated).toBe(false);
  expect(store.list(null)).toEqual([]);
  expect(new DeviceStore(root).gated).toBe(false);
  expect(store.match(candidate.token)).toEqual(candidate.device);
  expect(store.gated).toBe(true);
  expect(new DeviceStore(root).match(candidate.token)).toEqual(candidate.device);
});

it("does not commit a failed revocation", () => {
  const root = mkdtempSync(join(dir, "revoke-failure-"));
  const store = new DeviceStore(root);
  const only = store.pair(store.startPairing().code, "Phone", "drive")!;
  store.match(only.token);
  const before = readFileSync(join(root, "devices.json"), "utf8");
  const receipts: string[] = [];
  store.onRevoke(only.device.id, () => { receipts.push(only.device.id); });
  const realWrite = privateStateFs.writeSync;
  let writes = 0;
  const write = spyOn(privateStateFs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) =>
    realWrite(fd, buffer, offset, ++writes === 1 ? 7 : length)) as typeof realWrite);
  const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
  try {
    expect(() => store.revoke(only.device.id)).toThrow("EIO");
  } finally { write.mockRestore(); fsync.mockRestore(); }
  expect(writes).toBe(2);
  expect(receipts).toEqual([]);
  expect(store.has(only.device.id)).toBe(true);
  expect(store.match(only.token)?.id).toBe(only.device.id);
  expect(readdirSync(root)).toEqual(["devices.json"]);
  expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(before);

  expect(store.revoke(only.device.id)).toBe(true);
  expect(receipts).toEqual([only.device.id]);
  const reopened = new DeviceStore(root);
  expect(reopened.gated).toBe(true);
  expect(reopened.match(only.token)).toBeNull();
  expect(reopened.list(null)).toEqual([]);
});

it("flushes the last-seen update before it replaces the registry", () => {
  const root = mkdtempSync(join(dir, "last-seen-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  const confirmedAt = Date.now();
  const fsync = spyOn(privateStateFs, "fsyncSync");
  try {
    store.match(paired.token, confirmedAt);
    const authorizationSyncs = fsync.mock.calls.length;
    expect(authorizationSyncs).toBeGreaterThanOrEqual(1);
    store.match(paired.token, confirmedAt + 61_000);
    expect(fsync.mock.calls.length).toBeGreaterThan(authorizationSyncs);
  } finally { fsync.mockRestore(); }
  expect(new DeviceStore(root).list(null)[0]?.last_seen_at).toBe(new Date(confirmedAt + 61_000).toISOString());
});

it("notes when a relay device was last seen, at most once a minute on disk", async () => {
  const root = mkdtempSync(join(dir, "relay-last-seen-"));
  const store = new DeviceStore(root);
  const keys = await relayKeys();
  const pairedAt = Date.now() - 120_000;
  const paired = store.pairRelay(store.startPairing().code, "Phone", keys.publicKeySpki, pairedAt)!;
  expect(new DeviceStore(root).list(null)[0]?.last_seen_at).toBe(new Date(pairedAt).toISOString());
  const auth = async (now: number) => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    return store.matchRelay(paired.device.id, nonce, await relaySignature(keys.privateKey, nonce), "server-a", now);
  };
  const seenAt = Date.now();
  expect(await auth(seenAt)).toEqual(paired.device);
  expect(new DeviceStore(root).list(null)[0]?.last_seen_at).toBe(new Date(seenAt).toISOString());
  expect(await auth(seenAt + 30_000)).toEqual(paired.device);
  expect(new DeviceStore(root).list(null)[0]?.last_seen_at).toBe(new Date(seenAt).toISOString());
  expect(await auth(seenAt + 61_000)).toEqual(paired.device);
  expect(new DeviceStore(root).list(null)[0]?.last_seen_at).toBe(new Date(seenAt + 61_000).toISOString());
  const before = readFileSync(join(root, "devices.json"), "utf8");
  const blocked = new DeviceStore(root, "Sibling registry unreadable");
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  expect(await blocked.matchRelay(paired.device.id, nonce, await relaySignature(keys.privateKey, nonce), "server-a", seenAt + 200_000)).toEqual(paired.device);
  expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(before);
});

it("keeps the previous registry intact and the credential valid when a last-seen write fails before rename", () => {
  const root = mkdtempSync(join(dir, "last-seen-failure-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  const confirmedAt = Date.now();
  store.match(paired.token, confirmedAt);
  const before = readFileSync(join(root, "devices.json"), "utf8");
  const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
  try {
    expect(store.match(paired.token, confirmedAt + 61_000)).toEqual(paired.device);
    expect(rename).toHaveBeenCalledTimes(1);
  } finally { rename.mockRestore(); }
  expect(readdirSync(root)).toEqual(["devices.json"]);
  expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(before);
  const reopened = new DeviceStore(root);
  expect(reopened.error).toBeNull();
  expect(reopened.list(null)[0]?.last_seen_at).toBe(new Date(confirmedAt).toISOString());
  expect(reopened.match(paired.token, confirmedAt + 62_000)).toEqual(paired.device);
});
