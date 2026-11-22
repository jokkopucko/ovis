import { symlinkSync } from "node:fs";
import { join } from "node:path";
import type { createServer } from "../index.ts";
import { DEVICE_COOKIE } from "../auth.ts";
import type { DirectCarrier } from "../relay/direct.ts";
import type { RelaySession } from "../relay/session.ts";
import type { applyAccountRecords } from "./records.ts";

export const V057 = "acab7685663bebc0ce2e93c75b4e3c4048d9f0bb";
const RELEASE = { "v0.5.6": "c482ad601132ebb80c0013f9d9063d474eac96c1", "v0.5.7": V057 } as const;

export function hasReleaseFixtures(...tags: (keyof typeof RELEASE)[]): boolean {
  if (process.env.CI) return true; // CI must fail, rather than silently dropping the release matrix.
  const missing = (tags.length ? tags : ["v0.5.7"] as const).filter(tag =>
    Bun.spawnSync(["git", "cat-file", "-e", `${RELEASE[tag]}^{commit}`], {
      cwd: join(import.meta.dir, "../.."), env: { ...process.env, GIT_MASTER: "1" }, stdout: "ignore", stderr: "ignore",
    }).exitCode !== 0);
  if (missing.length > 0) {
    console.warn(`Skipping release-backed upgrade tests: missing ${missing.join(", ")} (${missing.map(tag => `git fetch origin tag ${tag}`).join("; ")})`);
  }
  return missing.length === 0;
}

/** Run the release's own writers in disposable state, not Step 2 with an option flipped. */
export async function v057Fixture(checkout: string, tag: keyof typeof RELEASE = "v0.5.7") {
  const repo = join(import.meta.dir, "../..");
  const archive = Bun.spawnSync(["git", "archive", RELEASE[tag]], { cwd: repo, env: { ...process.env, GIT_MASTER: "1" } });
  if (archive.exitCode !== 0) throw new Error(`Need the ${tag} release object (git fetch origin tag ${tag}): ${archive.stderr.toString()}`);
  await new Bun.Archive(archive.stdout).extract(checkout);
  symlinkSync(join(repo, "node_modules"), join(checkout, "node_modules"), "junction");
  const release: { readonly createServer: typeof createServer } = await import(join(checkout, "server/index.ts"));
  const direct: { DirectCarrier: typeof DirectCarrier } = await import(join(checkout, "server/relay/direct.ts"));
  const relay: { RelaySession: typeof RelaySession } = await import(join(checkout, "server/relay/session.ts"));
  const records: { applyAccountRecords: typeof applyAccountRecords } = await import(join(checkout, "server/account/records.ts"));
  const start = (stateDir: string, options: Pick<NonNullable<Parameters<typeof createServer>[0]>, "siblingStateDir" | "accountOpensAll" | "accountService" | "desktopOwner"> = {}) => release.createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "matrix-owner", sidecar: false,
    tailscaleOwner: null, accountOpensAll: false, accountService: { url: "off" }, ...options,
  });
  return Object.assign(start, direct, relay, records);
}

export function credentialStatus(port: number, token: string): Promise<number> {
  return fetch(`http://127.0.0.1:${port}/api/devices`, { headers: {
    cookie: `${DEVICE_COOKIE}=${token}`, "x-forwarded-for": "100.64.0.9",
  } }).then(async response => { await response.arrayBuffer(); return response.status; });
}
