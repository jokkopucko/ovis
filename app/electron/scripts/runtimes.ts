/**
 * Each download is checked against the SHA-256 written here before it is used,
 * so a build never takes whatever a server hands out that day.
 */
import { createHash } from "node:crypto";

export const HC_VERSION = "0.1.17";
export const BUN_VERSION = "1.4.4";

export type Target = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";
export const TARGETS: readonly Target[] = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];

export interface Pinned {
  url: string;
  sha256: string;
}

// releases.herdr.dev/core/0.1.17/manifest.json
const hcFile = (name: string, ext = "tar.gz") => `https://releases.herdr.dev/core/${HC_VERSION}/herdr-core-${name}.${ext}`;
export const HC: Record<Target, Pinned> = {
  "linux-x64": { url: hcFile("linux-x86_64"), sha256: "82ec44043f6894bfdb716b979b87cda43fd7fa46b0104e7b7bd93e64d1a9b877" },
  "linux-arm64": { url: hcFile("linux-aarch64"), sha256: "3a37a454ec63494cf4306db26481fe9db96673d888723701d24f8a992ae8ab8c" },
  "darwin-x64": { url: hcFile("macos-x86_64"), sha256: "e2dc3211edb1f1c77d0e73dd76c1426636d71050f34a5303916a56d363d7062b" },
  "darwin-arm64": { url: hcFile("macos-aarch64"), sha256: "cedbd4d4d9ba1385588198dd4d3c67d2654478f33add5b6445d4d0eb9da5fcf3" },
  // herdr-core.exe with the ConPTY it runs terminals on (conpty/), which goes beside it
  "win32-x64": { url: hcFile("windows-x86_64", "zip"), sha256: "a212b69db0efb808882683f15e5da45ab9606da7bcc54b97b29ed4fa540f5491" },
};

// oven-sh/bun bun-v1.4.4 SHASUMS256.txt; the same Bun as CI (.github/actions/setup-ci) and the remote bundles
const bunFile = (name: string) => `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${name}.zip`;
export const BUN: Record<Target, Pinned & { folder: string }> = {
  "linux-x64": { url: bunFile("bun-linux-x64"), folder: "bun-linux-x64", sha256: "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c" },
  "linux-arm64": { url: bunFile("bun-linux-aarch64"), folder: "bun-linux-aarch64", sha256: "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e" },
  "darwin-x64": { url: bunFile("bun-darwin-x64"), folder: "bun-darwin-x64", sha256: "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e" },
  "darwin-arm64": { url: bunFile("bun-darwin-aarch64"), folder: "bun-darwin-aarch64", sha256: "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510" },
  "win32-x64": { url: bunFile("bun-windows-x64"), folder: "bun-windows-x64", sha256: "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5" },
};
/** Bun's license, which its release archives do not carry */
export const BUN_LICENSE: Pinned = {
  url: `https://raw.githubusercontent.com/oven-sh/bun/bun-v${BUN_VERSION}/LICENSE.md`,
  sha256: "362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd",
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
