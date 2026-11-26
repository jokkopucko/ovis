/**
 *   bun scripts/build-server.ts sign <dir> [--public-key <base64>]
 *                                                 ovis-server.json.sig, with the private key in OVIS_SERVER_SIGNING_KEY,
 *                                                 only when its public half is RELEASE_PUBLIC_KEY (scripts/server-manifest.ts)
 *                                                 or the key the flag names (a test's own); prints that public key
 *   bun scripts/build-server.ts verify <dir> [--public-key <base64>] [--expect-version <X.Y.Z>]
 *                                                 the folder, the signature (by RELEASE_PUBLIC_KEY unless the flag names
 *                                                 another), the manifest, every file and the sums; exit 1 with one line
 *                                                 naming what does not match. A consumer passes the version it asked for:
 *                                                 the signature alone does not stop an older release being offered
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keeperManifestText } from "./release-assets.ts";
import { DIST_ARCHIVE, generateKeyPair, KEY_FILE, publicKeyOf, RELEASE_PUBLIC_KEY, releaseFile, SERVER_PLATFORMS, type ServerPlatform, SIGNING_KEY_VARIABLE, signManifest, sourceTrees, verifyRelease, writeManifest } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const USAGE = `usage: bun scripts/build-server.ts <${SERVER_PLATFORMS.join("|")}> <dir> | release <dir> | manifest <dir> | keeper-manifest <assets-dir> <ovis-server.json> <version> | sign <dir> [--public-key <base64>] | verify <dir> [--public-key <base64>] [--expect-version <X.Y.Z>] | keygen <dir>`;
const isPlatform = (value: string | undefined): value is ServerPlatform => (SERVER_PLATFORMS as readonly string[]).includes(value ?? "");
const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

// the compile and what it needs load only for a build: sign and verify run where no package is installed
const artifact = () => import("./server-artifact.ts");

function flags(rest: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index]!, rest[index + 1]];
    if (!allowed.includes(flag) || value === undefined || options.has(flag)) fail(USAGE, 2);
    options.set(flag, value!);
  }
  return options;
}

async function main(args: string[]): Promise<void> {
  const [verb, dir, ...rest] = args;
  if (dir === undefined) fail(USAGE, 2);
  const out = resolve(dir!);
  if (isPlatform(verb) && rest.length === 0) {
    const { binaryName, buildBinary } = await artifact();
    mkdirSync(out, { recursive: true });
    await buildBinary(verb, join(out, binaryName(verb)));
  } else if (verb === "release" && rest.length === 0) {
    const { binaryName, buildBinary } = await artifact();
    mkdirSync(out, { recursive: true });
    for (const platform of SERVER_PLATFORMS) {
      const staging = mkdtempSync(join(out, `.${platform}-`));
      try {
        await buildBinary(platform, join(staging, binaryName(platform)));
        renameSync(join(staging, binaryName(platform)), join(out, releaseFile(platform)));
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    if (!existsSync(join(root, "dist", "index.html"))) fail("Run bun run build first: the release carries the built client (dist/) as ovis-dist.tar.gz");
    const archive = join(out, `.${DIST_ARCHIVE}.tmp`);
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", join(root, "dist"), "."], { stderr: "pipe" });
    if (tar.exitCode !== 0) fail(`Could not pack dist/: ${tar.stderr.toString().trim()}`);
    renameSync(archive, join(out, DIST_ARCHIVE));
  } else if (verb === "manifest" && rest.length === 0) {
    const sources = sourceTrees();
    if ("error" in sources) fail(sources.error);
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    console.log(JSON.stringify(writeManifest(out, { version, sources: sources as { server: string; shared: string } }), null, 2));
  } else if (verb === "keeper-manifest" && rest.length === 2) {
    const [serverManifest, version] = rest;
    if (!serverManifest || !version) return fail(USAGE, 2);
    process.stdout.write(keeperManifestText(out, version, readFileSync(serverManifest)));
  } else if (verb === "sign") {
    const expected = flags(rest, ["--public-key"]).get("--public-key") ?? RELEASE_PUBLIC_KEY;
    const key = process.env[SIGNING_KEY_VARIABLE]?.trim();
    if (!key) fail(`${SIGNING_KEY_VARIABLE} is not set, so ovis-server.json cannot be signed and the release must not be published. The owner adds the secret ${SIGNING_KEY_VARIABLE} to the environment release-signing (docs/development.md, "The server binary's signing key").`);
    let publicKey = "";
    try {
      // checked before anything is written: a key in the secret that is not the committed one must fail the release
      const offered = publicKeyOf(`${key}\n`);
      if (offered !== expected) fail(`${SIGNING_KEY_VARIABLE} is the key ${offered}, not ${expected}, which scripts/server-manifest.ts commits and every installer trusts: nothing was signed`);
      publicKey = signManifest(out, `${key}\n`);
    } catch (error) {
      fail(`ovis-server.json was not signed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const check = verifyRelease(out, publicKey);
    if (!check.ok) fail(check.problems.join("\n"));
    console.error("signed ovis-server.json");
    console.log(publicKey);
  } else if (verb === "verify") {
    const options = flags(rest, ["--public-key", "--expect-version"]);
    const publicKey = options.get("--public-key") ?? RELEASE_PUBLIC_KEY;
    const version = options.get("--expect-version");
    const result = verifyRelease(out, publicKey, version === undefined ? {} : { version });
    if (!result.ok) fail(result.problems.join("\n"));
    console.log(`ovis-server.json${version === undefined ? "" : ` for ${version}`} is signed by ${publicKey}, and every binary matches it`);
  } else if (verb === "keygen" && rest.length === 0) {
    // the file's mode keeps the key to its owner on Linux and macOS; on Windows a mode sets no access rule, and the key
    // would be as readable as the folder it lands in
    if (process.platform === "win32") fail("keygen does not run on Windows, where it cannot make the key file readable by you alone: run it on Linux or macOS");
    const { privateKeyPem, publicKey } = generateKeyPair();
    mkdirSync(out, { recursive: true });
    try {
      writeFileSync(join(out, KEY_FILE), privateKeyPem, { mode: 0o600, flag: "wx" });
    } catch (error) {
      fail(`${join(out, KEY_FILE)} was not written (${error instanceof Error ? error.message : String(error)}); an existing key is never replaced`);
    }
    console.log(publicKey);
    console.error(`private key: ${join(out, KEY_FILE)} (readable by you alone). Put it in the secret ${SIGNING_KEY_VARIABLE} of the environment release-signing, never a repository secret: gh secret set ${SIGNING_KEY_VARIABLE} --env release-signing --repo devswha/ovis < <that file>. Keep a copy offline, then delete this file.`);
  } else {
    fail(USAGE, 2);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
