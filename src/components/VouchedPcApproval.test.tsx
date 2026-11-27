import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { RemotePairingRequest } from "../../shared/protocol.ts";
import * as Api from "../lib/api.ts";
import * as Join from "../lib/account/join.ts";
import * as Service from "../lib/account/service.ts";
import * as Store from "../lib/account/store.ts";
import * as Vouched from "../lib/account/vouched-pc.ts";
import { SettingsProvider } from "../lib/settings.ts";
import * as Approval from "./AccountApprovalPrompt.tsx";
import { VouchedPcApproval } from "./VouchedPcApproval.tsx";

const SESSION = { account: "acct", service: "https://account.example", provider: "github", sign_in_id: "s", access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };
let failed: unknown;
let approveFails = 0;
const decided: string[] = [];

class FakeService {
  async session() { return SESSION; }
  forSignIn() { return this; }
  async recentAdmissions() { return []; }
}
const real = { approval: { ...Approval }, api: { ...Api }, join: { ...Join }, service: { ...Service }, store: { ...Store }, vouched: { ...Vouched } };

let page: Page;
const request = { id: "req-1", key: "device-key", proven_server_id: "p".repeat(32), vouched: true } as unknown as RemotePairingRequest;
const settle = async (): Promise<void> => { for (let round = 0; round < 10; round++) await act(async () => {}); };

beforeEach(async () => {
  page = openPage("https://pc.example/");
  await mock.module("./AccountApprovalPrompt.tsx", () => ({ ...real.approval,
    AccountApprovalPrompt: ({ vouchedName, onDecide }: Approval.AccountApprovalPromptProps) => <><output>{vouchedName}</output>
      {vouchedName && <button onClick={() => { void onDecide("approve").catch((error: unknown) => { failed = error; }); }}>Allow</button>}</>,
  }));
  await mock.module("../lib/api.ts", () => ({ ...real.api, decideRelayPairing: async (_id: string, answer: string) => { decided.push(answer); } }));
  await mock.module("../lib/account/vouched-pc.ts", () => ({ ...real.vouched, vouchedPcName: async () => "Desk" }));
  await mock.module("../lib/account/join.ts", () => ({ ...real.join,
    vouchedAdmission: () => ({ server_id: "p".repeat(32) }),
    approveJoin: async () => { if (approveFails > 0) { approveFails--; throw new Error("503 from the service"); } decided.push("approve"); },
  }));
  await mock.module("../lib/account/store.ts", () => ({ ...real.store, indexedAccountStore: { ...real.store.indexedAccountStore, key: async () => ({ public_spki: "my-key" }) } }));
  await mock.module("../lib/account/service.ts", () => ({ ...real.service, AccountService: FakeService, accountServiceOf: () => SESSION.service }));
});

afterEach(async () => {
  try { await page.close(); } finally {
    // Bun's module mocks are shared by every test file in this process.
    await mock.module("./AccountApprovalPrompt.tsx", () => real.approval);
    await mock.module("../lib/api.ts", () => real.api);
    await mock.module("../lib/account/vouched-pc.ts", () => real.vouched);
    await mock.module("../lib/account/join.ts", () => real.join);
    await mock.module("../lib/account/store.ts", () => real.store);
    await mock.module("../lib/account/service.ts", () => real.service);
    failed = undefined;
    approveFails = 0;
    decided.length = 0;
  }
});

it("offers Allow again once the PC is verified anew after an Allow that failed, and still Denies", async () => {
  await page.render(createElement(SettingsProvider, { children: createElement(VouchedPcApproval, { request, through: "t".repeat(32) }) }));
  await settle();
  expect(page.one("output").textContent).toBe("Desk");
  approveFails = 1;
  await act(async () => page.one("button").click());
  expect(failed).toBeInstanceOf(Error);
  expect(decided).toEqual([]);
  await settle();
  expect(page.one("output").textContent).toBe("Desk");
  await act(async () => page.one("button").click());
  expect(decided).toEqual(["approve"]);
});
