/**
 *   bun scripts/release-guards.ts --base <sha>      CI (ci.yml, Fast checks): a remote-vN tag may still be unpublished
 *   bun scripts/release-guards.ts --release X.Y.Z   release.yml preflight: remote-vN must be published from this tree,
 *                                                   its manifest and archives downloadable, not only tagged
 *   bun scripts/release-guards.ts --worker-deployed after `wrangler deploy`: records the Worker in telemetry/deployed.json
 *
 * Reads tags, so a shallow checkout fetches them first (ci.yml does).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseNotes } from "./release-notes.ts";
import { SUMMARIES_FILE } from "../server/release-notes.ts";
import { discard, readCappedJson, REMOTE_LIMITS, RemoteResponseInvalid, RemoteResponseTooLarge } from "../server/remote-json.ts";

const root = resolve(import.meta.dir, "..");
const MACHINES = "shared/machines.ts";

export const BUNDLE_PATHSPECS = ["server", "shared", "integrations", "patches", "bun.lock", "scripts/build-remote-bundle.ts", "scripts/server-artifact.ts", "scripts/install-gjc-integration.ts", "scripts/install-pi-integration.ts", "scripts/pty-sidecar.ts", "crates/pty-sidecar"];
export const bundleInput = (path: string): boolean => BUNDLE_PATHSPECS.some((spec) => path === spec || path.startsWith(`${spec}/`))
  && !path.endsWith(".test.ts") && !path.endsWith(".md") && !path.startsWith("server/fixtures/");
export const BUNDLE_WORKFLOW = ".github/workflows/remote-bundles.yml";
export const bunPins = (workflow: string): string => [...workflow.matchAll(/bun-version:\s*(\S+)/g)].map((match) => match[1]).join(" ");
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "patchedDependencies", "overrides", "trustedDependencies"];
export const dependencies = (packageJson: string): string => {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  return JSON.stringify(DEPENDENCY_FIELDS.map((field) => parsed[field] ?? null));
};

export const bundleVersion = (machines: string): string => {
  const version = /^export const REMOTE_BUNDLE_VERSION = "(\d+)";$/m.exec(machines)?.[1];
  if (!version) throw new Error(`REMOTE_BUNDLE_VERSION not found in ${MACHINES}`);
  return version;
};

export interface BundleFacts {
  version: number;
  published: number[];
  changed: string[] | null;
  publishing: boolean;
}

export function bundleProblems({ version, published, changed, publishing }: BundleFacts): string[] {
  const latest = Math.max(0, ...published);
  const next = Math.max(version, latest) + 1;
  if (version < latest) return [`REMOTE_BUNDLE_VERSION is ${version} but remote-v${latest} exists: raise it to ${next} in ${MACHINES}.`];
  if (changed === null) {
    return publishing ? [`remote-v${version} is not published. Push the tag remote-v${version} on this commit, wait for the Remote PC bundles workflow to publish it, then run Release again (docs/remote-pcs.md).`] : [];
  }
  if (changed.length === 0) return [];
  const shown = changed.slice(0, 10).join(", ") + (changed.length > 10 ? `, and ${changed.length - 10} more` : "");
  return [`The remote bundle's inputs changed since remote-v${version} (${shown}), so remote PCs would keep the old server. Raise REMOTE_BUNDLE_VERSION in ${MACHINES} from ${version} to ${next} in the release PR (or, when it already merged, in a follow-up PR); after it merges, push remote-v${next} on the merged commit and wait for the Remote PC bundles workflow before running Release (docs/development.md#releasing).`];
}

export const manifestUrl = (version: number): string => `https://github.com/devswha/ovis/releases/download/remote-v${version}/manifest.json`;
export const BUNDLE_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
export type Get = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Why remote-v<version>, tagged, is not published yet: the Remote PC bundles workflow uploads the
 * manifest and the archives only after building and testing them, so a Release run started in
 * between would ship an app whose remote PCs find no bundle.
 */
export async function publishedProblems(version: number, get: Get = fetch): Promise<string[]> {
  const url = manifestUrl(version);
  const wait = `Wait for the Remote PC bundles workflow of the tag remote-v${version} to publish it (rerun it if it failed), then run Release again (docs/development.md#releasing).`;
  const signal = AbortSignal.timeout(60_000);
  const read = async (target: string, headers: Record<string, string> = {}): Promise<Response | string> => {
    try {
      const response = await get(target, { headers, signal });
      if (response.ok) return response;
      await discard(response);
      return `${target} answered ${response.status}`;
    } catch (error) {
      return `${target} could not be read (${(error as Error).message})`;
    }
  };
  const answer = await read(url);
  if (typeof answer === "string") return [`remote-v${version} is tagged but not published: ${answer}. ${wait}`];
  let manifest: { version?: unknown; assets?: Record<string, { url?: unknown; sha256?: unknown } | undefined> } | null;
  try { manifest = await readCappedJson<typeof manifest>(answer, REMOTE_LIMITS.bundleManifest); } catch (error) {
    const why = error instanceof RemoteResponseTooLarge ? "is larger than remote PCs accept" : error instanceof RemoteResponseInvalid ? "is not JSON" : `could not be read (${(error as Error).message})`;
    return [`remote-v${version} is not published: ${url} ${why}. ${wait}`];
  }
  if (manifest?.version !== String(version)) return [`remote-v${version} is not published: ${url} names version ${JSON.stringify(manifest?.version ?? null)}. ${wait}`];
  const missing: string[] = [];
  const assets: string[] = [];
  for (const platform of BUNDLE_PLATFORMS) {
    const asset = manifest?.assets?.[platform];
    if (typeof asset?.url === "string" && asset.url.startsWith("https://") && typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/.test(asset.sha256)) assets.push(asset.url);
    else missing.push(platform);
  }
  if (missing.length > 0) return [`remote-v${version} is not published for every platform: ${url} has no bundle for ${missing.join(", ")}. ${wait}`];
  // the GET remote PCs download with, for its first byte only: the archive answers, says it is not
  // empty and delivers that byte (headers alone are not a download)
  const unreachable = (await Promise.all(assets.map(async (asset) => {
    const response = await read(asset, { range: "bytes=0-0" });
    if (typeof response === "string") return response;
    // the size the answer declares; null when it declares none (a chunked 200 from a host without ranges)
    const declared = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ?? (response.status === 200 ? response.headers.get("content-length") : null);
    const size = declared === null ? null : Number(declared);
    let received = 0;
    const reader = response.body?.getReader();
    try {
      while (reader && received === 0) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
    } catch (error) {
      return `${asset} failed before its first byte (${(error as Error).message})`;
    } finally {
      await reader?.cancel().catch(() => {});
    }
    return received > 0 && size !== 0 ? null : `${asset} is empty`;
  }))).filter((result) => result !== null);
  return unreachable.length > 0 ? [`remote-v${version} is not published: ${unreachable.join("; ")}. ${wait}`] : [];
}

export const WORKER_SOURCES = ["telemetry/worker.ts", "shared/telemetry.ts"];
export const DEPLOYED_FILE = "telemetry/deployed.json";
export const workerFingerprint = (sources: string[]): string => {
  const hash = createHash("sha256");
  for (const source of sources) hash.update(source.replace(/\r\n/g, "\n")).update("\0");
  return hash.digest("hex");
};

/** The strict Worker refuses a settings snapshot whose keys or values it does not know, so an app that sends a newer one loses its events. */
export function workerProblems(current: string, deployed: string | undefined): string[] {
  if (current === deployed) return [];
  return [`${WORKER_SOURCES.join(" or ")} changed since the Worker was last deployed (${DEPLOYED_FILE}). The deployed Worker refuses a settings snapshot with a key or value it does not know, so this release's events would be lost. Any edit to those files counts, comments and client-only exports included; a redeploy that changes nothing is the expected cost. Deploy the Worker first (telemetry/README.md: database columns, then \`bunx wrangler deploy\` from telemetry/), then run \`bun scripts/release-guards.ts --worker-deployed\` and commit ${DEPLOYED_FILE} in the release PR (or a follow-up PR when it already merged).`];
}

export function metadataProblems(read: (path: string) => string, version: string): string[] {
  try {
    releaseNotes(version, version, read("herdr-plugin.toml"), read("CHANGELOG.md"), read(SUMMARIES_FILE));
    return [];
  } catch (error) {
    return [`${(error as Error).message}. A release PR bumps package.json and herdr-plugin.toml, cuts the CHANGELOG.md section and writes ${SUMMARIES_FILE} (docs/development.md#releasing).`];
  }
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, out: result.stdout.toString() };
}

export interface Verdict {
  version: string | null;
  problems: string[];
}

export function check(cwd: string, publishing: boolean, base?: string): Verdict {
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  const tags = git(cwd, "tag", "--list").out.split("\n").filter(Boolean);
  if (!tags.some((tag) => /^v\d/.test(tag))) throw new Error("No v* tags: fetch them first (git fetch --tags), or a release cannot be told apart from any other tree.");
  if (!publishing && tags.includes(`v${version}`)) return { version: null, problems: [] };
  const before = base && !publishing ? git(cwd, "show", `${base}:package.json`) : null;
  if (before?.ok && (JSON.parse(before.out) as { version: string }).version === version) return { version: null, problems: [] };

  const bundle = Number(bundleVersion(read(MACHINES)));
  const published = tags.flatMap((tag) => /^remote-v(\d+)$/.exec(tag)?.[1] ?? []).map(Number);
  let changed: string[] | null = null;
  if (published.includes(bundle)) {
    const tag = `remote-v${bundle}`;
    const diff = git(cwd, "diff", "--name-only", `${tag}^{commit}`, "HEAD", "--", ...BUNDLE_PATHSPECS);
    if (!diff.ok) throw new Error(`Cannot compare with ${tag}: fetch its commit first (git fetch --depth=1 origin tag ${tag}).`);
    changed = diff.out.split("\n").filter((path) => path && bundleInput(path));
    const tagged = git(cwd, "show", `${tag}^{commit}:package.json`);
    if (tagged.ok && dependencies(tagged.out) !== dependencies(read("package.json"))) changed.push("package.json dependencies");
    const workflow = git(cwd, "show", `${tag}^{commit}:${BUNDLE_WORKFLOW}`);
    let pins = "";
    try { pins = bunPins(read(BUNDLE_WORKFLOW)); } catch { /* no workflow in this tree */ }
    if (workflow.ok && bunPins(workflow.out) !== pins) changed.push(`${BUNDLE_WORKFLOW} bun-version`);
  }

  let deployed: string | undefined;
  try { deployed = (JSON.parse(read(DEPLOYED_FILE)) as { sha256?: string }).sha256; } catch { /* never recorded */ }
  return {
    version,
    problems: [
      ...metadataProblems(read, version),
      ...bundleProblems({ version: bundle, published, changed, publishing }),
      ...workerProblems(workerFingerprint(WORKER_SOURCES.map(read)), deployed),
    ],
  };
}

export async function releaseCheck(cwd: string, get: Get = fetch): Promise<Verdict> {
  const verdict = check(cwd, true);
  const bundle = Number(bundleVersion(readFileSync(join(cwd, MACHINES), "utf8")));
  if (git(cwd, "rev-parse", "-q", "--verify", `refs/tags/remote-v${bundle}`).ok) verdict.problems.push(...await publishedProblems(bundle, get));
  return verdict;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--worker-deployed") {
    const sha256 = workerFingerprint(WORKER_SOURCES.map((path) => readFileSync(join(root, path), "utf8")));
    writeFileSync(join(root, DEPLOYED_FILE), JSON.stringify({
      sha256,
      about: `sha256 of ${WORKER_SOURCES.join(" + ")} as last deployed; written by bun scripts/release-guards.ts --worker-deployed after bunx wrangler deploy`,
    }, null, 2) + "\n");
    console.log(`${DEPLOYED_FILE}: ${sha256}`);
  } else {
    const publishing = args[0] === "--release";
    const base = args[0] === "--base" ? args[1] : undefined;
    if (base && !git(root, "show", `${base}:package.json`).ok) console.log(`::warning::Cannot read package.json at --base ${base}; checking HEAD as a release.`);
    const verdict = publishing ? await releaseCheck(root) : check(root, false, base || undefined);
    if (publishing && verdict.version !== args[1]) verdict.problems.unshift(`package.json version ${verdict.version} is not the requested ${args[1] ?? "(none)"}.`);
    if (verdict.version === null) console.log("Not a release (package.json's version is tagged, or the base already has it): nothing to check.");
    for (const problem of verdict.problems) console.error(`::error::${problem}`);
    if (verdict.problems.length > 0) process.exit(1);
    if (verdict.version !== null) console.log(`Release ${verdict.version}: remote bundle, telemetry Worker and release metadata are in order.`);
  }
}
