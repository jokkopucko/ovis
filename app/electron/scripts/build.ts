/**
 * Builds Ovis for the desktop on the machine it is for (Linux or macOS, x64 or arm64):
 *
 *   bun scripts/build.ts stage    pinned herdr-core and Bun, checked, plus the Ovis server, into stage/
 *   bun scripts/build.ts bundle   the main process and preload into out/
 *   bun scripts/build.ts          both, then the installers into dist/ (AppImage; dmg and zip)
 *   bun scripts/build.ts package  the bundle and the installers from the stage/ already there
 *   bun scripts/build.ts merge-feed <out> <latest-mac.yml>…   the Mac builds' feeds as one (scripts/feed.ts)
 *
 * OVIS_UPDATE_FEED=https://… builds the app to update itself from that generic feed.
 * OVIS_RELEASE_TAG=vX.Y.Z (the release workflow) stops the build unless package.json says X.Y.Z.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeFeeds } from "./feed.ts";
import { BUN, BUN_LICENSE, BUN_VERSION, download, HC, HC_VERSION, hostTarget, sha256, type Pinned } from "./runtimes.ts";

const here = resolve(import.meta.dir, "..");
const repo = resolve(here, "..", "..");
const step = process.argv[2] ?? "dist";
if (!["stage", "bundle", "package", "dist", "merge-feed"].includes(step)) throw new Error("Usage: bun scripts/build.ts [stage|bundle|package|merge-feed <out> <feed>…]");
if (step === "merge-feed") {
  const [out, ...inputs] = process.argv.slice(3);
  if (!out || inputs.length === 0) throw new Error("Usage: bun scripts/build.ts merge-feed <out> <latest-mac.yml>…");
  writeFileSync(out, mergeFeeds(inputs.map((name) => ({ name, text: readFileSync(name, "utf8") }))));
  process.exit(0);
}
const target = hostTarget();
const cache = join(here, ".cache", target);
const stage = join(here, "stage");

async function sh(argv: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`${argv.join(" ")} failed in ${cwd}\n${output}`);
  return output;
}

/** a pinned download, kept in the cache; a cached copy is used only while it still hashes to its pin */
async function cached(name: string, pin: Pinned): Promise<string> {
  const path = join(cache, name);
  if (!existsSync(path) || sha256(readFileSync(path)) !== pin.sha256) writeFileSync(path, await download(pin));
  return path;
}

/** the checked archives, unpacked afresh into extracted/ on every build: nothing unpacked earlier is trusted */
async function fetchRuntimes(): Promise<string> {
  mkdirSync(cache, { recursive: true });
  const hc = await cached("hc.tar.gz", HC[target]);
  const bun = await cached("bun.zip", BUN[target]);
  const license = await cached("bun-LICENSE.md", BUN_LICENSE);
  const out = join(cache, "extracted");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "hc"), { recursive: true });
  await sh(["tar", "-xzf", hc, "-C", join(out, "hc"), "herdr-core", "LICENSE", "THIRD-PARTY-NOTICES"], out);
  await sh(["unzip", "-q", bun, "-d", out], out);
  cpSync(license, join(out, "bun-LICENSE.md"));
  return out;
}

function copyExecutable(from: string, to: string): void {
  cpSync(from, to);
  chmodSync(to, 0o755);
}

async function stageAll(): Promise<void> {
  const runtimes = await fetchRuntimes();
  rmSync(stage, { recursive: true, force: true });
  for (const dir of ["bin", "licenses/herdr-core", "licenses/bun", "server/scripts"]) mkdirSync(join(stage, dir), { recursive: true });
  copyExecutable(join(runtimes, "hc", "herdr-core"), join(stage, "bin", "herdr-core"));
  copyExecutable(join(runtimes, BUN[target].folder, "bun"), join(stage, "bin", "bun"));
  for (const name of ["LICENSE", "THIRD-PARTY-NOTICES"]) cpSync(join(runtimes, "hc", name), join(stage, "licenses", "herdr-core", name));
  cpSync(join(runtimes, "bun-LICENSE.md"), join(stage, "licenses", "bun", "LICENSE.md"));
  const hc = (await sh([join(stage, "bin", "herdr-core"), "--version"], stage)).trim();
  if (hc !== `hc ${HC_VERSION}`) throw new Error(`The staged herdr-core says "${hc}", not hc ${HC_VERSION}`);
  const bun = (await sh([join(stage, "bin", "bun"), "--version"], stage)).trim();
  if (bun !== BUN_VERSION) throw new Error(`The staged Bun says ${bun}, not ${BUN_VERSION}`);

  // the server as the installer and the remote bundles run it: its sources, the built client and its production packages
  await sh(["bun", "run", "build"], repo);
  const server = join(stage, "server");
  for (const dir of ["server", "shared", "integrations", "dist", "patches"]) {
    cpSync(join(repo, dir), join(server, dir), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
  }
  for (const file of ["package.json", "bun.lock"]) cpSync(join(repo, file), join(server, file));
  for (const script of ["install-gjc-integration.ts", "install-pi-integration.ts"]) cpSync(join(repo, "scripts", script), join(server, "scripts", script));
  await sh([join(stage, "bin", "bun"), "install", "--production", "--frozen-lockfile", "--ignore-scripts"], server, { ...process.env, BUN_INSTALL_CACHE_DIR: join(here, ".cache", "bun-install") });
  // package-manager links: nothing runs them, and an installer need not carry symlinks
  rmSync(join(server, "node_modules", ".bin"), { recursive: true, force: true });
  // the release's Rust PTY host (checked against the release manifest), which a sign-in the server
  // follows in a terminal of its own needs on a PC without Node; without it the build goes on
  await sh(["bun", "scripts/pty-sidecar.ts", "install"], repo);
  const host = join(repo, "bin", "ovis-pty-sidecar");
  if (existsSync(host)) {
    mkdirSync(join(server, "bin"));
    copyExecutable(host, join(server, "bin", "ovis-pty-sidecar"));
    if (existsSync(`${host}.json`)) cpSync(`${host}.json`, join(server, "bin", "ovis-pty-sidecar.json"));
  } else {
    console.log("no Rust PTY host for this version: the app's server falls back to Node, where the PC has it");
  }
  // the project's own license and notices, for the client, server and assets the app carries
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(join(repo, file), join(stage, file));
  writeFileSync(join(stage, "versions.json"), JSON.stringify({ hc: HC_VERSION, bun: BUN_VERSION }));
  cpSync(join(repo, "app", "web", "ovis-logo.png"), join(here, "renderer", "ovis-logo.png"));
  console.log(`staged herdr-core ${HC_VERSION}, Bun ${BUN_VERSION} and the Ovis server for ${target} in ${stage}`);
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

async function bundle(): Promise<void> {
  rmSync(join(here, "out"), { recursive: true, force: true });
  await sh(["bun", "build", "src/main.ts", "src/preload.ts", "--target=node", "--format=cjs", "--outdir=out", "--external", "electron"], here);
  // the packages the bundle took in (electron-updater and what it uses) ship with their license texts
  const main = readFileSync(join(here, "out", "main.js"), "utf8");
  const packages = [...new Set([...main.matchAll(/^\/\/ node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gm)].map((match) => match[1]!))].sort();
  const texts = packages.map((name) => {
    const dir = join(here, "node_modules", name);
    const { version, license, author } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license: string; author?: string | { name: string } };
    const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(entry));
    // a few MIT packages publish no license file: their package.json names the license and the author
    if (!file && license !== "MIT") throw new Error(`${name} has no license file to ship`);
    const text = file ? readFileSync(join(dir, file), "utf8").trim() : `Copyright (c) ${typeof author === "string" ? author : author?.name ?? `the ${name} authors`}\n\n${MIT}`;
    return `${name} ${version} (${license})\n\n${text}\n`;
  });
  writeFileSync(join(here, "out", "THIRD_PARTY_LICENSES.txt"), texts.join("\n" + "-".repeat(72) + "\n\n"));
}

async function dist(): Promise<void> {
  const version = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
  // the app says the release's version, which is also the server's it carries
  const tag = process.env["OVIS_RELEASE_TAG"]?.trim();
  if (tag && tag !== `v${version}`) throw new Error(`OVIS_RELEASE_TAG is ${tag}, but package.json says ${version}`);
  const [os, arch] = target.split("-") as [string, string];
  const platform = os === "darwin" ? "mac" : "linux";
  // the CPU written out, since electron-builder's ${arch} says x86_64 in an AppImage's name and amd64 in a deb's
  const args = [join(here, "node_modules", ".bin", "electron-builder"), `--${platform}`, `--${arch}`, "--publish", "never", `-c.extraMetadata.version=${version}`, `-c.${platform}.artifactName=Ovis-${platform}-${arch}.\${ext}`];
  const feed = process.env["OVIS_UPDATE_FEED"]?.trim();
  if (feed) {
    if (new URL(feed).protocol !== "https:") throw new Error("OVIS_UPDATE_FEED must be an https address");
    args.push("-c.publish.provider=generic", `-c.publish.url=${feed}`);
  }
  const child = Bun.spawn(args, { cwd: here, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("electron-builder failed");
}

if (step === "stage" || step === "dist") await stageAll();
if (step !== "stage") await bundle();
if (step === "package" || step === "dist") {
  if (!existsSync(join(stage, "versions.json"))) throw new Error("Nothing staged: run bun scripts/build.ts stage first");
  await dist();
}
