import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { rotateRelayIdentity, savedServerId } from "../relay/identity.ts";
import { ACCOUNT } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "upgrade-browser-sibling-"));
const available = hasReleaseFixtures();
let release: Awaited<ReturnType<typeof v057Fixture>>;
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cells = (["A", "B"] as const).flatMap(first =>
  (["kept", "deleted", "foreign"] as const).map(history => [first, history] as const));
test.skipIf(!available).each(cells)("browser-only sibling first=%s history=%s", async (first, history) => {
  const dir = mkdtempSync(join(root, "cell-"));
  const folders = { A: join(dir, "a"), B: join(dir, "b") };
  mkdirSync(folders.A);
  mkdirSync(folders.B);
  rotateRelayIdentity(folders.A);
  const owner = await phone();
  const member = release(folders.A);
  try {
    const { devices } = member.context.services;
    const paired = devices.pairRelay(devices.startPairing().code, "Account member", owner.spki);
    if (!paired || !devices.linkAccountKey(paired.device.id, owner.spki, owner.spki, ACCOUNT)) throw new Error("Release binding failed");
  } finally { await member.stop(); }
  const browser = release(folders.B);
  let token: string;
  let id: string;
  try {
    const { devices } = browser.context.services;
    const paired = devices.pair(devices.startPairing().code, "Browser-only phone", "drive");
    if (!paired) throw new Error("Release browser pairing failed");
    token = paired.token;
    id = paired.device.id;
    expect(await credentialStatus(browser.port, token)).toBe(200);
    expect(savedServerId(folders.B)).toBeUndefined();
  } finally { await browser.stop(); }
  const second = first === "A" ? "B" : "A";
  for (const folder of ["A", "A", "B"] as const) {
    const merged = release(folders[folder], { siblingStateDir: folders[folder === "A" ? "B" : "A"] });
    try { expect(await credentialStatus(merged.port, token)).toBe(200); } finally { await merged.stop(); }
  }
  expect(savedServerId(folders.B)).toBeUndefined();
  if (history === "deleted") {
    const old = release(folders.B);
    try {
      expect(old.context.services.devices.revoke(id)).toBe(true);
      expect(await credentialStatus(old.port, token)).toBe(401);
    } finally { await old.stop(); }
  }
  if (history === "foreign") rotateRelayIdentity(folders.B);
  const outcomes: number[] = [];
  for (const folder of [first, second, first] as const) {
    const app = createServer({
      stateDir: folders[folder], siblingStateDir: folders[folder === "A" ? "B" : "A"],
      port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
      accountOpensAll: true, accountService: { url: "off" },
    });
    try { outcomes.push(await credentialStatus(app.port, token)); } finally { await app.stop(); }
  }
  expect(outcomes).toEqual([first, second, first].map(folder =>
    history === "deleted" || history === "foreign" && folder === "A" ? 401 : 200));
}, 15_000);
