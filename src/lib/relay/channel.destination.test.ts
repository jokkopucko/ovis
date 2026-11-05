import { expect, it, mock } from "bun:test";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { openRelayChannel, UnsafeRelayDestinationError } from "./channel.ts";

const unsafeDestinations = [
  { field: "relay", value: "ws://relay.example" },
  { field: "relay", value: "http://relay.example" },
  { field: "relay", value: "https://relay.example" },
  { field: "relay", value: "wss://relay.example/path" },
  { field: "relay", value: "wss://relay.example/" },
  { field: "relay", value: "wss://relay.example?role=server" },
  { field: "relay", value: "wss://relay.example#fragment" },
  { field: "relay", value: "wss://user@relay.example" },
  { field: "relay", value: "wss://user:password@relay.example" },
  { field: "server_id", value: `${"12".repeat(16)}&role=server&connection_id=${"34".repeat(16)}` },
  { field: "server_id", value: "AB".repeat(16) },
  { field: "server_id", value: "12".repeat(15) },
  { field: "server_id", value: "12".repeat(17) },
] as const;

for (const { field, value } of unsafeDestinations) {
  it(`refuses unsafe ${field} ${value} before touching storage or sockets`, async () => {
    // Given an offer passed directly to the exported boundary, bypassing decodeOffer.
    const offer = {
      v: 1 as const, relay: "wss://relay.example", server_id: "12".repeat(16),
      server_public_key: exportPublicKey(generateKeyPair().publicKey),
      [field]: value,
    };
    const store = {
      get: mock(async () => undefined),
      update: mock(async () => { throw new Error("Unexpected device-store update"); }),
      list: mock(async () => { throw new Error("Unexpected device-store list"); }),
      remove: mock(async () => { throw new Error("Unexpected device-store removal"); }),
    };
    const socket = mock(() => { throw new Error("Unexpected socket creation"); });
    // When the destination is validated.
    const opening = openRelayChannel(offer, { store, socket });
    // Then a typed failure precedes every storage or network side effect.
    await expect(opening).rejects.toBeInstanceOf(UnsafeRelayDestinationError);
    await expect(opening).rejects.toMatchObject({ code: "unsafe_relay_destination", field });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  });
}
