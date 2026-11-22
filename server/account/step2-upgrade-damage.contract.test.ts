import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-damage-"));
let release: Awaited<ReturnType<typeof v057Fixture>>;
const available = hasReleaseFixtures();
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!available).each([
  ["devices.json", "truncated"], ["devices.json", "unreadable-target"],
  [REMOVAL_FILE, "missing"], [REMOVAL_FILE, "truncated"], [REMOVAL_FILE, "not-private"],
] as const)("upgraded PC refuses %s (%s) without rewriting it, then recovers", async (name, damage) => {
  if ((damage === "not-private" || damage === "unreadable-target") && process.platform === "win32") return;
  const stateDir = mkdtempSync(join(root, "pc-"));
  const old = release(stateDir);
  let token: string;
  try {
    const { devices } = old.context.services;
    const paired = devices.pair(devices.startPairing().code, "Existing phone", "drive");
    if (!paired) throw new Error("v0.5.7 did not pair the phone");
    token = paired.token;
    expect(await credentialStatus(old.port, token)).toBe(200);
  } finally { await old.stop(); }
  const start = () => createServer({
    stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: "off" },
  });
  const upgraded = start();
  try { expect(await credentialStatus(upgraded.port, token)).toBe(200); } finally { await upgraded.stop(); }
  const path = join(stateDir, name);
  const intact = readFileSync(path, "utf8");
  const invalid = damage === "truncated" ? '{"v":' : intact;
  rmSync(path);
  const missingTarget = join(stateDir, "missing-registry");
  if (damage === "unreadable-target") symlinkSync(missingTarget, path);
  else if (damage !== "missing") writeFileSync(path, invalid, { mode: damage === "not-private" ? 0o666 : 0o600 });
  if (damage === "not-private") chmodSync(path, 0o666);
  const unusable = start();
  try {
    expect(await credentialStatus(unusable.port, token)).toBe(401);
    expect(await credentialStatus(unusable.port, "never-paired")).toBe(401);
    if (damage === "missing") expect(() => readFileSync(path)).toThrow();
    else if (damage === "unreadable-target") expect(readlinkSync(path)).toBe(missingTarget);
    else expect(readFileSync(path, "utf8")).toBe(invalid);
  } finally { await unusable.stop(); }

  rmSync(path, { force: true });
  writeFileSync(path, intact, { mode: 0o600 });
  const repaired = start();
  try { expect(await credentialStatus(repaired.port, token)).toBe(200); } finally { await repaired.stop(); }
});
