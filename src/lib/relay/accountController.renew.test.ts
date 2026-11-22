import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { memoryAccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore, SavedDevice } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";

describe("account carrier renewal", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => browser.dispose());

  it("finishes linking an existing pairing only after its account-key carrier renews", async () => {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.test", name: "Desk" };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: "https://account.ovis.sh", account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const key = await accountStore.key();
    let device: SavedDevice = { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone" };
    const store: ShellDeviceStore = {
      get: async () => device,
      list: async () => [device],
      remove: async () => { throw new Error("Unexpected pairing removal"); },
      removeRow: async () => { throw new Error("Unexpected pairing removal"); },
      update: async (_id, change) => { device = change(device); return device; },
    };
    class LinkingTransport extends RelayTransport {
      renewalPending = false;
      readonly renewed = Promise.withResolvers<void>();
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {
        this.renewalPending = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
        this.renewalPending = false;
        this.renewed.resolve();
      }
      override async fetch(path: string) {
        if (this.renewalPending) throw new TypeError("Relay carrier is disconnected");
        switch (path) {
          case "/api/account/status": return Response.json({ account: "acct-test", unlinked: [device.device_id], removals: [], enrolling: false });
          case "/api/account/link": return Response.json({});
          case "/api/account/introduction": return Response.json({ pcs: [] });
          default: throw new Error(`Unexpected account path: ${path}`);
        }
      }
    }
    const opened = new LinkingTransport(offer);
    const controller = createAccountController({
      container: Object.create(null), entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, store, accountStore,
      accountService: "https://account.ovis.sh", accountFetch: async () => Response.json({ pcs: [] }),
      renderApp: () => ({ render() {}, unmount() {} }),
    }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
    try {
      expect(await controller.enroll(opened, offer.server_id, false)).toEqual({ state: "complete" });
      expect(device.account_enrollment).toEqual({ account: "acct-test", state: "complete" });
    } finally { await opened.renewed.promise; opened.close(); }
  });
});
