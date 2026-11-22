import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { FrameType, KEY_PROOF_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { pairingPc, phone, SERVER_ID, type Phone } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

export async function keyProofPc(accountOpensAll: boolean, platform: NodeJS.Platform = "linux") {
  const told: { pending: { id: string; action: { kind: string; pending?: string; fingerprint?: string } }[] }[] = [];
  const sender = Promise.withResolvers<(line: string) => void>();
  const input = new ReadableStream<Uint8Array>({ start(controller) { sender.resolve((line) => controller.enqueue(new TextEncoder().encode(line))); } });
  const push = await sender.promise;
  const made = await pairingPc({ prepare: dir => { PcAccountState.open(dir).migrate("acct_proof", true); },
    server: { accountOpensAll, platform, desktopOwner: { input, write: (line) => { told.push(JSON.parse(line)); } } } });
  const screen = {
    told,
    approve: (id: string) => push(`${JSON.stringify({ approve: id })}\n`),
    decline: (id: string) => push(`${JSON.stringify({ decline: id })}\n`),
    keyConfirm: () => told.at(-1)?.pending.find((entry) => entry.action.kind === "approve_key"),
  };
  return Object.assign(made, { screen });
}

/** A device that offers the proof: it pairs, answers the challenge, and reports what it saw. */
export async function provingDevice(made: Parameters<typeof relayConnection>[0], code: string, options?: Parameters<typeof relayConnection>[1], named?: Phone) {
  const device = named ?? await phone();
  const serverId = options?.serverId ?? SERVER_ID;
  const link = await relayConnection(made, options);
  const challenge = deferred<string>();
  const pending = deferred<MuxFrame>();
  link.onFrame = (frame) => {
    if (frame.type === FrameType.KEY_CHALLENGE) challenge.resolve(frame.payload.challenge);
    if (frame.type === FrameType.KEY_PENDING) pending.resolve(frame);
  };
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  const sent = await bounded(challenge.promise);
  link.mux.sendSession({ type: FrameType.KEY_PROVE, flags: 0, stream_id: 0, payload: { signature: await signPairProof(serverId, sent, device.spki, device.keys.privateKey) } });
  const fingerprint = await pairFingerprint(serverId, sent, device.spki);
  // the bounded wait starts only when a test asks for KEY_PENDING: one that must never come leaves no timer behind
  let waited: Promise<MuxFrame> | undefined;
  return { device, link, challenge: sent, get pending() { return waited ??= bounded(pending.promise); }, fingerprint };
}
