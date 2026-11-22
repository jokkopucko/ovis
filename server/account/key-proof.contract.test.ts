/**
 * A relay pairing that proves its key (device-row-states rows T71, T72, S31; the hub's and security-triage's S2-13
 * conditions), end to end through a relay session: HELLO with key-proof-1, PAIR, KEY_CHALLENGE, KEY_PROVE,
 * KEY_PENDING, and a row only when this PC's screen approves that very key.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { FrameType, KEY_PROOF_FEATURE } from "../../shared/relay-mux.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { bounded, deferred, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_FILE } from "./device-journal.ts";
import { memberRow, pair, pairingPc, phone, setUpFor, vouchFor, type Pc } from "./pairing.test-helpers.ts";
import { keyProofPc, provingDevice } from "./key-proof.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(accountOpensAll: boolean, platform?: NodeJS.Platform) {
  const made = await keyProofPc(accountOpensAll, platform);
  pcs.push(made);
  return made;
}

test("T71/T72: the device proves its key, waits, and is let in only when the PC's screen approves that key", async () => {
  const made = await pc(true);
  const code = await made.offerCode();
  const paired = await provingDevice(made, code);
  expect((await paired.pending).payload).toEqual({});
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
  const asked = made.screen.keyConfirm();
  expect(asked?.action).toEqual({ kind: "approve_key", pending: expect.any(String), fingerprint: paired.fingerprint });
  const admitted = deferred<void>();
  paired.link.onFrame = (frame) => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(); };
  made.screen.approve(asked!.id);
  await bounded(admitted.promise);
  expect(made.stored().find((row) => row.relay_public_key === paired.device.spki)).toBeDefined();
});

test("T72: a decline on the screen ends the pairing and lets nobody in", async () => {
  const made = await pc(true);
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  made.screen.decline(made.screen.keyConfirm()!.id);
  expect(await bounded(paired.link.serverError)).toBe("auth_failed");
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
});

test("T71: an app that does not offer the proof is refused with a code an app from before it already shows, not left waiting", async () => {
  const made = await pc(true);
  const device = await phone();
  const link = await relayConnection(made);
  await link.hello();
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code: await made.offerCode(), label: "Old app", public_key: device.spki } });
  // unsupported_version is in every released decoder's list (shared/relay-mux.ts SESSION_ERRORS before key-proof-1)
  expect(await bounded(link.serverError)).toBe("unsupported_version");
});

test("T71: with the release flag off, pairing is today's: no challenge, the device is let in", async () => {
  const made = await pc(false);
  const device = await phone();
  const link = await relayConnection(made);
  const types: number[] = [];
  link.onFrame = (frame) => { types.push(frame.type); };
  const admitted = await link.pair(await made.offerCode(), device.spki);
  expect(admitted.device_id).toMatch(/^[0-9a-f]{16}$/);
  expect(types).not.toContain(FrameType.KEY_CHALLENGE);
});

test("T71: on Linux, a pairing waits for the screen even when no screen path answers, and is never let in by its code alone", async () => {
  const made = await pairingPc({ rows: [(await memberRow("acct_1")).row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
});

test("T71: on a PC with no screen proof (macOS, Windows), pairing is today's, flag on or off", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const made = await pairingPc({ server: { accountOpensAll: true, platform } });
    pcs.push(made);
    const device = await phone();
    const link = await relayConnection(made);
    const admitted = await link.pair(await made.offerCode(), device.spki);
    expect(admitted.device_id).toMatch(/^[0-9a-f]{16}$/);
  }
});

test("T72/S31: a device that goes away before it proves its key gives the code's use back, and its relay link counted it as pairing", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const device = await phone();
  const link = await relayConnection(made);
  const challenged = deferred<void>();
  link.onFrame = (frame) => { if (frame.type === FrameType.KEY_CHALLENGE) challenged.resolve(); };
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  await bounded(challenged.promise);
  expect(link.session.pairing).toBe(true);
  link.stop();
  await bounded(link.closed);
  expect(made.devices.redeemCode(code, "code", device.spki)).toMatchObject({ ok: true });
});

test("T72/S31: a proved device waiting for the screen counts as pairing, and once it goes away it is no longer listed", async () => {
  const made = await pc(true, "linux");
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  expect(paired.link.session.pairing).toBe(true);
  paired.link.stop();
  await bounded(paired.link.closed);
  expect((await made.local("/api/devices/pending")).body.pending).toEqual([]);
});

test("T71/T72: a decline is journalled as a drop that names the device's key and name", async () => {
  const made = await pc(true, "linux");
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  made.screen.decline(made.screen.keyConfirm()!.id);
  await bounded(paired.link.serverError);
  const entries = (JSON.parse(readFileSync(join(made.stateDir, JOURNAL_FILE), "utf8")) as { entries: { kind: string; key: string | null; label: string }[] }).entries;
  expect(entries.filter((entry) => entry.kind === "drop")).toEqual([expect.objectContaining({ key: paired.device.spki, label: "New phone" })]);
});

test("S31/T71: while one proved device waits for the screen, a second device with the same code gets its own challenge", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const first = await provingDevice(made, code);
  await first.pending;
  const second = await provingDevice(made, code);
  await second.pending;
  expect((await made.local("/api/devices/pending")).body.pending).toHaveLength(2);
});

test("T71: a code that ends (cancelled here) drops the devices that wait on it", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const paired = await provingDevice(made, code);
  await paired.pending;
  expect(made.devices.endPairing({ code })).toBe(true);
  expect((await made.local("/api/devices/pending")).body.pending).toEqual([]);
  expect(await bounded(paired.link.serverError)).toBe("auth_failed");
});

test("a first-link QR on an unbound Linux PC keeps Step 1's account-vouched first link", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  await setUpFor(made, "acct_1");
  const key = await phone();
  await vouchFor(made, "acct_1", key);
  expect(await pair(made, await made.tabCode(), key)).not.toHaveProperty("error");
  expect(made.app.context.services.localConfirms).toBeUndefined();
});

test("T5/T71: a PC whose code pairing is paused for too many wrong codes starts no key proof", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  for (let index = 0; index < 20; index++) made.devices.noteRelayFailure("code");
  const device = await phone();
  const link = await relayConnection(made);
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  expect(await bounded(link.serverError)).toBe("auth_failed");
  expect(made.screen.keyConfirm()).toBeUndefined();
});

test("T71: a relay pass that lets in no new device starts no key proof and puts nothing on the screen", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const asked = deferred<void>();
  const link = await relayConnection(made, { refuseNewDevice: () => { asked.resolve(); return true; } });
  const device = await phone();
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  await bounded(asked.promise);
  expect((await made.local("/api/devices/pending")).body.pending).toEqual([]);
  expect(made.devices.redeemCode(code, "code", device.spki)).toMatchObject({ ok: true });
  expect(made.screen.keyConfirm()).toBeUndefined();
});

/** The approve_key prompts the PC's screen shows now. */
const prompts = (made: Awaited<ReturnType<typeof pc>>) => (made.screen.told.at(-1)?.pending ?? []).filter((entry) => entry.action.kind === "approve_key");

test("S31/T72: a device that goes away before its proof frees its slot: five other devices can still wait on the code", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const gone = await relayConnection(made);
  const challenged = deferred<void>();
  gone.onFrame = (frame) => { if (frame.type === FrameType.KEY_CHALLENGE) challenged.resolve(); };
  await gone.hello([KEY_PROOF_FEATURE]);
  gone.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "Gone", public_key: (await phone()).spki } });
  await bounded(challenged.promise);
  gone.stop();
  await bounded(gone.closed);
  for (let index = 0; index < 5; index++) await (await provingDevice(made, code)).pending;
  expect((await made.local("/api/devices/pending")).body.pending).toHaveLength(5);
});

test("T71/T72: Revoke all while a prompt is up withdraws it; approving it then admits nobody and writes no row", async () => {
  const made = await pc(true, "linux");
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  const stale = made.screen.keyConfirm()!;
  made.devices.revokeAll();
  expect(prompts(made)).toEqual([]);
  made.screen.approve(stale.id);
  expect(await bounded(paired.link.serverError)).toBe("auth_failed");
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
});

test("T71/T72: a relay identity reset while a prompt is up withdraws it; approving it then admits nobody", async () => {
  const made = await pc(true, "linux");
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  const stale = made.screen.keyConfirm()!;
  await made.app.context.services.relay.resetIdentity();
  expect(prompts(made)).toEqual([]);
  made.screen.approve(stale.id);
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
});

test("T71/T72: a device that goes away withdraws its prompt", async () => {
  const made = await pc(true, "linux");
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  expect(prompts(made)).toHaveLength(1);
  paired.link.stop();
  await bounded(paired.link.closed);
  expect(prompts(made)).toEqual([]);
});

test("S31/T71: admitting one of two devices on a code withdraws the other's prompt, and approving that stale prompt admits nobody", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const first = await provingDevice(made, code);
  await first.pending;
  const second = await provingDevice(made, code);
  await second.pending;
  const [one, two] = prompts(made);
  const admitted = deferred<void>();
  first.link.onFrame = (frame) => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(); };
  const firstPrompt = [one, two].find((entry) => entry!.action.fingerprint === first.fingerprint)!;
  const secondPrompt = [one, two].find((entry) => entry!.action.fingerprint === second.fingerprint)!;
  made.screen.approve(firstPrompt.id);
  await bounded(admitted.promise);
  expect(await bounded(second.link.serverError)).toBe("auth_failed");
  expect(prompts(made)).toEqual([]);
  made.screen.approve(secondPrompt.id);
  expect(made.stored().some((row) => row.relay_public_key === second.device.spki)).toBe(false);
});

test("T71/T72: a code that runs out drops the devices waiting on it and withdraws their prompts, with nobody looking", async () => {
  const made = await pc(true, "linux");
  const clock = new TestClock();
  made.devices.useClock(clock);
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  expect(prompts(made)).toHaveLength(1);
  clock.advance(10 * 60_000 + 1);
  expect(prompts(made)).toEqual([]);
  expect(await bounded(paired.link.serverError)).toBe("auth_failed");
  expect((await made.local("/api/devices/pending")).body.pending).toEqual([]);
});

test("S13-1: a code that ends after the proof is published, before the relay goes on, sends no KEY_PENDING and puts no prompt up", async () => {
  const made = await pc(true, "linux");
  const code = await made.offerCode();
  const sent: number[] = [];
  const asks = spyOn(made.app.context.services.localConfirms!, "request");
  const send = MuxEngine.prototype.sendSession;
  const outbound = spyOn(MuxEngine.prototype, "sendSession").mockImplementation(function (this: MuxEngine, frame) { sent.push(frame.type); return send.call(this, frame); });
  // the code ends two turns after the entry is published: after KeyProofPairings.prove has named it for the session
  // and resolved, before the relay session goes on to KEY_PENDING (the gate's handoff; one turn sooner the session is
  // still unnamed and the prove() check refuses, one turn later KEY_PENDING has gone out legitimately)
  const stop = made.app.context.services.pendingRedemptions!.onChange(() => { stop(); queueMicrotask(() => queueMicrotask(() => { made.devices.endPairing({ code }); })); });
  try {
    const paired = await provingDevice(made, code);
    expect(await bounded(paired.link.serverError)).toBe("auth_failed");
    expect(sent).not.toContain(FrameType.KEY_PENDING);
    expect(asks).not.toHaveBeenCalled();
    expect(made.screen.keyConfirm()).toBeUndefined();
    expect((await made.local("/api/devices/pending")).body.pending).toEqual([]);
  } finally { outbound.mockRestore(); asks.mockRestore(); }
});
