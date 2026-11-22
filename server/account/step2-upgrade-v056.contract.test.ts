import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-v056-"));
let from056: Awaited<ReturnType<typeof v057Fixture>>;
let through057: typeof from056;
const available = hasReleaseFixtures("v0.5.6", "v0.5.7");
beforeAll(async () => {
  if (!available) return;
  [from056, through057] = await Promise.all([
    v057Fixture(join(root, "v056"), "v0.5.6"),
    v057Fixture(join(root, "v057")),
  ]);
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!available).each([
  ["direct", "paired"], ["direct", "gated-empty"],
  ["via-v0.5.7", "paired"], ["via-v0.5.7", "gated-empty"],
] as const)("v0.5.6 upgrade path=%s registry=%s", async (path, registry) => {
  const stateDir = mkdtempSync(join(root, "state-"));
  const app = from056(stateDir);
  let credential: string;
  try {
    const { devices } = app.context.services;
    const paired = devices.pair(devices.startPairing().code, "Existing phone", "drive");
    if (!paired) throw new Error("v0.5.6 did not pair the phone");
    credential = paired.token;
    expect(await credentialStatus(app.port, credential)).toBe(200);
    if (registry === "gated-empty") {
      expect(devices.revoke(paired.device.id)).toBe(true);
      expect(await credentialStatus(app.port, credential)).toBe(401);
    }
  } finally { await app.stop(); }

  const status = registry === "paired" ? 200 : 401;
  const check = async (opened: ReturnType<typeof createServer>) => {
    try {
      expect(await credentialStatus(opened.port, credential)).toBe(status);
      expect(await credentialStatus(opened.port, "never-paired")).toBe(401);
    } finally { await opened.stop(); }
  };
  try {
    if (path === "via-v0.5.7") await check(through057(stateDir));
    await check(createServer({
      stateDir, port: 0, hostname: "127.0.0.1", tailscaleOwner: null, token: "matrix-owner", sidecar: false,
      accountOpensAll: true, accountService: { url: "off" },
    }));
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
