/**
 * The programs the desktop app carries, pinned: herdr-core (`hc`) runs the terminals and Bun runs
 * the Ovis server. Each download is checked against the SHA-256 written here before it is used,
 * so a build never takes whatever a server hands out that day. A version bump updates these.
 */
import { createHash } from "node:crypto";

export const HC_VERSION = "0.1.17";
export const BUN_VERSION = "1.4.2";

export type Target = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";
export const TARGETS: readonly Target[] = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

export interface Pinned {
  url: string;
  sha256: string;
}

// releases.herdr.dev/core/0.1.17/manifest.json
const hcFile = (name: string) => `https://releases.herdr.dev/core/${HC_VERSION}/herdr-core-${name}.tar.gz`;
export const HC: Record<Target, Pinned> = {
  "linux-x64": { url: hcFile("linux-x86_64"), sha256: "82ec44043f6894bfdb716b979b87cda43fd7fa46b0104e7b7bd93e64d1a9b877" },
  "linux-arm64": { url: hcFile("linux-aarch64"), sha256: "3a37a454ec63494cf4306db26481fe9db96673d888723701d24f8a992ae8ab8c" },
  "darwin-x64": { url: hcFile("macos-x86_64"), sha256: "e2dc3211edb1f1c77d0e73dd76c1426636d71050f34a5303916a56d363d7062b" },
  "darwin-arm64": { url: hcFile("macos-aarch64"), sha256: "cedbd4d4d9ba1385588198dd4d3c67d2654478f33add5b6445d4d0eb9da5fcf3" },
};

// oven-sh/bun bun-v1.4.2 SHASUMS256.txt; the same Bun as CI (.github/actions/setup-ci) and the remote bundles
const bunFile = (name: string) => `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${name}.zip`;
export const BUN: Record<Target, Pinned & { folder: string }> = {
  "linux-x64": { url: bunFile("bun-linux-x64"), folder: "bun-linux-x64", sha256: "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913" },
  "linux-arm64": { url: bunFile("bun-linux-aarch64"), folder: "bun-linux-aarch64", sha256: "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7" },
  "darwin-x64": { url: bunFile("bun-darwin-x64"), folder: "bun-darwin-x64", sha256: "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012" },
  "darwin-arm64": { url: bunFile("bun-darwin-aarch64"), folder: "bun-darwin-aarch64", sha256: "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f" },
};
/** Bun's license, which its release archives do not carry */
export const BUN_LICENSE: Pinned = {
  url: `https://raw.githubusercontent.com/oven-sh/bun/bun-v${BUN_VERSION}/LICENSE.md`,
  sha256: "b9caf52728691b4057e371232c221a132883198be2f3d2ddf92c90404c984b1a",
};

export function hostTarget(platform: string = process.platform, arch: string = process.arch): Target {
  const target = `${platform}-${arch}`;
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error(`The desktop app is built for ${TARGETS.join(", ")}, not ${target}`);
  return target as Target;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function download(pin: Pinned, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetcher(pin.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}): ${pin.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = sha256(bytes);
  if (got !== pin.sha256) throw new Error(`Checksum mismatch for ${pin.url}: expected ${pin.sha256}, got ${got}`);
  return bytes;
}
