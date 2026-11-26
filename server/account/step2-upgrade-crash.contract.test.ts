import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { relayIdentityPath, rotateRelayIdentity } from "../relay/identity.ts";
import { bounded } from "../relay/test-helpers.ts";
import { ACCOUNT } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-crash-"));
let release: Awaited<ReturnType<typeof v057Fixture>>;
const available = hasReleaseFixtures();
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const crashCells = (["stamped-registry", "first-sibling-publication", "durable-revoke"] as const)
  .flatMap(boundary => (["writer", "sibling"] as const).map(restart => [boundary, restart] as const));

test.skipIf(!available || process.platform === "win32").each(crashCells)("SIGKILL after %s, first restart=%s", async (boundary, restart) => {
  const dir = mkdtempSync(join(root, "pc-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(join(b, "relay"), { recursive: true });
  rotateRelayIdentity(a);
  copyFileSync(relayIdentityPath(a), relayIdentityPath(b));
  const key = await phone();
  const old = release(a);
  let id: string;
  let cookie: string;
  try {
    const { devices } = old.context.services;
    const paired = devices.pairRelay(devices.startPairing().code, "Victim", key.spki);
    if (!paired || !devices.linkAccountKey(paired.device.id, key.spki, key.spki, ACCOUNT)) throw new Error("Could not link released phone");
    id = paired.device.id;
    const browser = devices.pair(devices.startPairing().code, "Surviving browser", "drive");
    if (!browser) throw new Error("Could not pair released browser");
    cookie = browser.token;
    expect(await credentialStatus(old.port, cookie)).toBe(200);
    expect(devices.sessionRow(id)?.key).toBe(key.spki);
  } finally { await old.stop(); }
  await release(a, { siblingStateDir: b }).stop();
  if (boundary === "first-sibling-publication") {
    // An unrelated new row causes a two-folder publication. The tested phone already worked in both folders.
    const other = release(b);
    try {
      const { devices } = other.context.services;
      expect(await credentialStatus(other.port, cookie)).toBe(200);
      expect(devices.pair(devices.startPairing().code, "Sibling phone", "drive")).not.toBeNull();
    } finally { await other.stop(); }
  }
  const childCode = `
    const config = ${JSON.stringify({ a, b, id, boundary, removalPath: join(a, REMOVAL_FILE), registryPath: join(a, "devices.json") })};
    const { createServer } = await import(${JSON.stringify(join(import.meta.dir, "../index.ts"))});
    const { privateStateFs } = await import(${JSON.stringify(join(import.meta.dir, "../private-state.ts"))});
    const rename = privateStateFs.renameSync;
    let armed = config.boundary !== "durable-revoke";
    privateStateFs.renameSync = (from, to) => {
      rename(from, to);
      const path = String(to);
      if (armed && (
        config.boundary === "durable-revoke" ? path === config.removalPath
        : path === config.registryPath
      )) process.kill(process.pid, "SIGKILL");
    };
    const app = createServer({
      stateDir: config.a,
      ...(config.boundary === "stamped-registry" ? {} : { siblingStateDir: config.b }),
      port: 0, hostname: "127.0.0.1", token: "matrix-owner",
      tailscaleOwner: null, sidecar: false, accountOpensAll: true, accountService: { url: "off" },
    });
    if (config.boundary === "durable-revoke") {
      armed = true;
      app.context.services.devices.revoke(config.id);
    }
    await app.stop();
  `;
  // Without env, Bun.spawn hands the child the environment this process started with, not the
  // HERDR_SOCKET the test preload set: the child's server would reach the user's own herdr.
  const child = Bun.spawn([process.execPath, "-e", childCode], {
    env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "inherit",
  });
  try {
    await bounded(child.exited, 5_000);
    expect(child.signalCode).toBe("SIGKILL");
  } finally { if (!child.killed && child.exitCode === null) child.kill("SIGKILL"); }

  for (const stateDir of restart === "writer" ? [a, b] : [b, a]) {
    const next = createServer({
      stateDir, siblingStateDir: stateDir === a ? b : a, port: 0, hostname: "127.0.0.1", token: "matrix-owner",
      tailscaleOwner: null, sidecar: false, accountOpensAll: true, accountService: { url: "off" },
    });
    try {
      const { devices } = next.context.services;
      expect(await credentialStatus(next.port, cookie)).toBe(200);
      if (boundary === "durable-revoke") {
        expect(devices.sessionRow(id)).toBeNull();
        expect(devices.isTombstoned(key.spki)).toBe(true);
      } else {
        expect(devices.sessionRow(id)?.key).toBe(key.spki);
        expect(devices.isAccountApproverSession(id, key.spki)).toBe(false);
        expect(devices.originOf(id)?.admit_no ?? 0).toBe(0);
      }
    } finally { await next.stop(); }
  }
}, 18_000);
