import { describe, expect, it } from "bun:test";

import type { PcProbe, RelaySocket } from "../../../shared/relay-channel.ts";
import type { RelayDevice } from "../../../shared/relay-device.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { checkPc, sweepOf } from "./pcStatus.ts";
import { keyIdOf } from "./shellState.ts";

const socket = (() => { throw new Error("unused"); }) as (url: string) => RelaySocket;
const device = (change: Partial<RelayDevice> = {}): RelayDevice => ({
  server_id: "12".repeat(16), device_id: "0123456789abcdef", private_key: {} as CryptoKey, public_spki: "spki", label: "Phone",
  server_public_key: "key", relay: "wss://relay-ap.ovis.sh", ...change,
});

function probes(answers: Record<string, PcProbe>) {
  const asked: string[] = [];
  const probe = async (_offer: unknown, via: { direct: string } | { relay: string }): Promise<PcProbe> => {
    const where = "direct" in via ? via.direct : via.relay;
    asked.push(where);
    return answers[where] ?? { kind: "unreachable" };
  };
  return { asked, probe: probe as unknown as typeof import("../../../shared/relay-channel.ts").probePc };
}

describe("checking a saved PC", () => {
  it("names the first direct carrier that answers, a Tailscale address as Tailscale", async () => {
    const { asked, probe } = probes({ "ws://100.101.1.2:7319": { kind: "answered", ms: 21 } });
    const found = await checkPc(device({ direct: ["ws://192.168.0.9:7319", "ws://100.101.1.2:7319"] }), { relay: socket, direct: socket }, probe);
    expect(found).toEqual({ kind: "answered", route: "tailscale", rttMs: 21 });
    expect(asked).toEqual(["ws://192.168.0.9:7319", "ws://100.101.1.2:7319"]);
  });

  it("goes through the relay where it has no direct socket (a browser), and names the relay", async () => {
    const { asked, probe } = probes({ "wss://relay-ap.ovis.sh": { kind: "answered", ms: 48 } });
    expect(await checkPc(device({ direct: ["ws://192.168.0.9:7319"] }), { relay: socket }, probe)).toEqual({ kind: "answered", route: "relay", relay: "wss://relay-ap.ovis.sh", rttMs: 48 });
    expect(asked).toEqual(["wss://relay-ap.ovis.sh"]);
  });

  it("falls back from a regional relay that does not answer to the global one", async () => {
    const { probe } = probes({ "wss://relay.ovis.sh": { kind: "answered", ms: 140 } });
    expect(await checkPc(device(), { relay: socket }, probe)).toEqual({ kind: "answered", route: "relay", relay: "wss://relay.ovis.sh", rttMs: 140 });
  });

  it("falls back to the global relay from a regional one with nobody for the PC, as opening it does", async () => {
    const { probe } = probes({ "wss://relay-ap.ovis.sh": { kind: "silent" }, "wss://relay.ovis.sh": { kind: "answered", ms: 140 } });
    expect(await checkPc(device(), { relay: socket }, probe)).toEqual({ kind: "answered", route: "relay", relay: "wss://relay.ovis.sh", rttMs: 140 });
  });

  it("calls the PC offline when the relay has nobody for it, and the relay unreachable when none answers", async () => {
    expect(await checkPc(device(), { relay: socket }, probes({ "wss://relay-ap.ovis.sh": { kind: "silent" }, "wss://relay.ovis.sh": { kind: "silent" } }).probe)).toEqual({ kind: "offline", reason: "pc" });
    expect(await checkPc(device({ relay: "wss://relay.example" }), { relay: socket }, probes({}).probe)).toEqual({ kind: "offline", reason: "relay" });
    expect(await checkPc(device(), { relay: socket }, probes({ "wss://relay-ap.ovis.sh": { kind: "silent" } }).probe)).toEqual({ kind: "offline", reason: "relay" });
  });

  it("passes a relay's refusal on as a refusal, not as a relay this device could not reach", async () => {
    expect(await checkPc(device({ relay: "wss://relay.example" }), { relay: socket }, probes({ "wss://relay.example": { kind: "refused" } }).probe)).toEqual({ kind: "offline", reason: "refused" });
  });
});

describe("the PCs one sweep checks", () => {
  const pc = (name: string, change: Partial<RelayDevice> = {}): RelayDevice => {
    const key = exportPublicKey(generateKeyPair().publicKey);
    return device({ server_id: keyIdOf(key)!, server_public_key: key, name, ...change });
  };
  const names = (devices: RelayDevice[]) => devices.map((one) => one.name);

  it("are the paired ones whose key their id names, never a mismatched or unpaired one", () => {
    const mismatched = { ...pc("forged"), server_public_key: pc("other").server_public_key };
    expect(names(sweepOf([pc("a"), mismatched, pc("unpaired", { device_id: null }), pc("b")], 0, 8))).toEqual(["a", "b"]);
  });

  it("are at most the cap, starting at the cursor and wrapping, so every PC gets its turn", () => {
    const all = ["a", "b", "c", "d", "e"].map((name) => pc(name));
    expect(names(sweepOf(all, 0, 3))).toEqual(["a", "b", "c"]);
    expect(names(sweepOf(all, 3, 3))).toEqual(["d", "e", "a"]);
    expect(names(sweepOf(all, 6, 3))).toEqual(["b", "c", "d"]);
    expect(names(sweepOf(all.slice(0, 2), 7, 3))).toEqual(["a", "b"]);
  });
});
