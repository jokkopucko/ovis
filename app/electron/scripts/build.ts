import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeFeeds } from "./feed.ts";
import { installedHelpers, releaseHelpers } from "./native.ts";
import { stageServerArtifact } from "../../../scripts/server-artifact.ts";
import { BUN, BUN_LICENSE, BUN_VERSION, download, HC, HC_VERSION, hostTarget, sha256, type Pinned } from "./runtimes.ts";
import { updateFeed, writeStagingMarker } from "../src/stagingProfile.ts";

const here = resolve(import.meta.dir, "..");
const repo = resolve(here, "..", "..");
const step = process.argv[2] === "--stage-only" ? "stage" : process.argv[2] ?? "dist";
if (!["stage", "bundle", "package", "dist", "merge-feed"].includes(step)) throw new Error("Usage: bun scripts/build.ts [stage|--stage-only|bundle|package|merge-feed <out> <feed>…]");
if (step === "merge-feed") {
  const [out, ...inputs] = process.argv.slice(3);
  if (!out || inputs.length === 0) throw new Error("Usage: bun scripts/build.ts merge-feed <out> <latest-mac.yml>…");
  writeFileSync(out, mergeFeeds(inputs.map((name) => ({ name, text: readFileSync(name, "utf8") }))));
  process.exit(0);
}
const target = hostTarget();
const windows = target === "win32-x64";
const exe = windows ? ".exe" : "";
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
  const hc = await cached(windows ? "hc.zip" : "hc.tar.gz", HC[target]);
  const bun = await cached("bun.zip", BUN[target]);
  const license = await cached("bun-LICENSE.md", BUN_LICENSE);
  const out = join(cache, "extracted");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "hc"), { recursive: true });
  if (windows) {
    // Windows' own tar opens zips; Git Bash's GNU tar, often first on the PATH there, cannot
    const tar = join(process.env["SystemRoot"] || "C:\\Windows", "System32", "tar.exe");
    await sh([tar, "-xf", hc, "-C", join(out, "hc")], out);
    await sh([tar, "-xf", bun, "-C", out], out);
  } else {
    await sh(["tar", "-xzf", hc, "-C", join(out, "hc"), "herdr-core", "LICENSE", "THIRD-PARTY-NOTICES"], out);
    await sh(["unzip", "-q", bun, "-d", out], out);
  }
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
  for (const dir of ["bin", "licenses/herdr-core", "licenses/bun"]) mkdirSync(join(stage, dir), { recursive: true });
  copyExecutable(join(runtimes, "hc", `herdr-core${exe}`), join(stage, "bin", `herdr-core${exe}`));
  // hc on Windows runs its terminals on the ConPTY beside it (conpty\conpty.dll, conpty\x64\OpenConsole.exe)
  if (windows) cpSync(join(runtimes, "hc", "conpty"), join(stage, "bin", "conpty"), { recursive: true });
  copyExecutable(join(runtimes, BUN[target].folder, `bun${exe}`), join(stage, "bin", `bun${exe}`));
  // THIRD-PARTY-NOTICES is a folder in the Windows zip, with ConPTY's license and notice in it
  for (const name of ["LICENSE", "THIRD-PARTY-NOTICES"]) cpSync(join(runtimes, "hc", name), join(stage, "licenses", "herdr-core", name), { recursive: true });
  cpSync(join(runtimes, "bun-LICENSE.md"), join(stage, "licenses", "bun", "LICENSE.md"));
  const hc = (await sh([join(stage, "bin", `herdr-core${exe}`), "--version"], stage)).trim();
  if (hc !== `hc ${HC_VERSION}`) throw new Error(`The staged herdr-core says "${hc}", not hc ${HC_VERSION}`);
  const bun = (await sh([join(stage, "bin", `bun${exe}`), "--version"], stage)).trim();
  if (bun !== BUN_VERSION) throw new Error(`The staged Bun says ${bun}, not ${BUN_VERSION}`);

  await sh(["bun", "run", "build"], repo);
  const tag = process.env["OVIS_RELEASE_TAG"]?.trim();
  const version: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
  if (tag && tag !== "v" + version) throw new Error("Release tag does not match package version");
  if (!tag && !windows) await sh(["bun", "scripts/pty-sidecar.ts", "install"], repo);
  const helpers = windows ? {} : tag ? await releaseHelpers(cache, target, { version, at: "https://github.com/devswha/ovis/releases/download/" + tag }) : installedHelpers(join(repo, "bin"));
  if (!helpers.ptySidecar) console.log("no Rust PTY host for this version: the app's server falls back to Node, where the PC has it");
  await stageServerArtifact({
    platform: windows ? "windows-x64" : target,
    dir: join(stage, "server"),
    nodePty: true,
    downloads: join(cache, "server-downloads"),
    ...helpers,
  });
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

/**
 * The Windows icon, as an .ico of PNG entries (16 to 256 pixels) from the app's icon. electron-builder
 * makes one itself from a PNG, but its icon tool spins for minutes on the 1024-pixel icon under
 * Bun's node (live-seen in the Windows VM, 10 minutes and still going).
 */
async function windowsIcon(): Promise<void> {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const source = join(here, "..", "assets", "icon-only.png");
  const images = await Promise.all(sizes.map(async (size) => new Uint8Array(await Bun.file(source).image().resize(size, size).png().bytes())));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + 16 * index;
    // 0 stands for 256 in an ICONDIRENTRY's one-byte width and height
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index]!.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index]!.length;
  });
  mkdirSync(join(here, ".cache"), { recursive: true });
  writeFileSync(join(here, ".cache", "icon.ico"), Buffer.concat([header, ...images]));
}

/**
 * The Linux icons, one PNG per size the hicolor theme lists (16 to 512 pixels), in the folder
 * electron-builder.yml names: the app's icon is 1024 pixels, a size no hicolor index lists, so
 * desktops that look only in listed folders showed a generic icon.
 */
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

async function linuxIcons(): Promise<void> {
  const source = join(here, "..", "assets", "icon-only.png");
  const dir = join(here, ".cache", "linux-icons");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await Promise.all(LINUX_ICON_SIZES.map(async (size) => writeFileSync(join(dir, `${size}x${size}.png`), await Bun.file(source).image().resize(size, size).png().bytes())));
}

async function dist(): Promise<void> {
  if (windows) await windowsIcon();
  if (target.startsWith("linux-")) await linuxIcons();
  const version = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
  const tag = process.env["OVIS_RELEASE_TAG"]?.trim();
  if (tag && tag !== `v${version}`) throw new Error(`OVIS_RELEASE_TAG is ${tag}, but package.json says ${version}`);
  const [os, arch] = target.split("-") as [string, string];
  const platform = os === "darwin" ? "mac" : windows ? "win" : "linux";
  // the CPU written out, since electron-builder's ${arch} says x86_64 in an AppImage's name and amd64 in a deb's
  const args = [join(here, "node_modules", ".bin", `electron-builder${windows ? ".exe" : ""}`), `--${platform}`, `--${arch}`, "--publish", "never", `-c.extraMetadata.version=${version}`, `-c.${platform}.artifactName=Ovis-${platform}-${arch}.\${ext}`];
  const staging = platform === "mac" && process.env["OVIS_BUILD_STAGING"] === "1";
  const feed = updateFeed(process.env, staging);
  if (feed) {
    if (new URL(feed).protocol !== "https:") throw new Error(`${staging ? "OVIS_PREVIEW_FEED" : "OVIS_UPDATE_FEED"} must be an https address`);
    args.push("-c.publish.provider=generic", `-c.publish.url=${feed}`);
  }
  writeStagingMarker(stage, staging);
  const child = Bun.spawn(args, { cwd: here, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("electron-builder failed");
}

if (step === "stage" || step === "dist") await stageAll();
if (step !== "stage") await bundle();
if (step === "package" || step === "dist") {
  if (!existsSync(join(stage, "versions.json"))) throw new Error("Nothing staged: run bun scripts/build.ts stage first");
  await dist();
}
