import { afterEach, describe, expect, it } from "bun:test";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST_ARCHIVE, generateKeyPair, MANIFEST, releaseFile, PTY_ASSETS, ptyFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";
import { download, installServer, NoBinaryRelease, releasesBase, verifiedInstall } from "./server-install.ts";

/**
 * The key reaches the installer only as the
 * option a test passes; the launcher passes none, so it checks the committed key.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-server-install-"));
  dirs.push(dir);
  return dir;
};
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sources = { server: "a".repeat(40), shared: "b".repeat(40) };
const PLATFORM = "linux-x64";

function release(base: string, version: string, privateKeyPem: string, client: Record<string, string> = { "index.html": "<!doctype html>" }, host?: string): string {
  const dir = join(base, `v${version}`);
  mkdirSync(dir, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `#!/bin/sh\necho ovis-server ${version} ${platform}\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), host ?? `pty host ${build}\n`);
  const tree = join(base, `client-${version}`);
  mkdirSync(tree, { recursive: true });
  for (const [name, text] of Object.entries(client)) writeFileSync(join(tree, name), text);
  const tar = Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", tree, "."]);
  expect(tar.exitCode).toBe(0);
  rmSync(tree, { recursive: true });
  writeManifest(dir, { version, sources });
  signManifest(dir, privateKeyPem);
  return dir;
}

function oldShape(base: string, version: string, privateKeyPem: string, edit: (manifest: Record<string, unknown>) => void = () => {}): string {
  const dir = join(base, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const assets: Record<string, { file: string; sha256: string }> = {};
  for (const platform of SERVER_PLATFORMS) {
    writeFileSync(join(dir, releaseFile(platform)), `old binary ${platform}\n`);
    assets[platform] = { file: releaseFile(platform), sha256: createHash("sha256").update(`old binary ${platform}\n`).digest("hex") };
  }
  const manifest: Record<string, unknown> = { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) }, assets };
  edit(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "ovis-server.json"), bytes);
  writeFileSync(join(dir, "ovis-server.json.sig"), `${sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64")}\n`);
  return dir;
}

function fixture(version = "1.2.3") {
  const root = scratch();
  const releases = join(root, "release");
  const home = join(root, "home");
  const key = generateKeyPair();
  const dir = release(releases, version, key.privateKeyPem);
  const install = (options: { version?: string; releases?: string; lockWaitMs?: number } = {}) =>
    installServer({ home, version: options.version ?? version, platform: PLATFORM, releases: options.releases ?? `file://${releases}`, publicKey: key.publicKey, lockWaitMs: options.lockWaitMs });
  return { root, releases, home, key, dir, install, binary: join(home, "bin", "ovis-server") };
}

function snapshot(home: string): Record<string, string> {
  if (!existsSync(home)) return {};
  const files: Record<string, string> = {};
  for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) files[path.slice(home.length)] = sha256(path);
    else if (entry.isSymbolicLink()) files[path.slice(home.length)] = `-> ${readlinkSync(path)}`;
  }
  return files;
}

describe.skipIf(process.platform === "win32")("installing the server from a release", () => {
  it("installs the binary and the client, checked, behind one link that a rename swaps", async () => {
    const { install, binary, dir, home } = fixture();
    const result = await install();
    expect(result.installed).toBe(true);
    expect(sha256(binary)).toBe(sha256(join(dir, releaseFile(PLATFORM))));
    expect(readFileSync(join(home, "bin", "dist", "index.html"), "utf8")).toBe("<!doctype html>");
    expect(lstatSync(join(home, "bin")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "bin", MANIFEST), "utf8")).version).toBe("1.2.3");
    expect(lstatSync(binary).mode & 0o111).not.toBe(0);
  });

  it("has nothing to do the second time, without reading the release again", async () => {
    const { install, releases, home } = fixture();
    await install();
    const before = snapshot(home);
    rmSync(releases, { recursive: true });
    const again = await install();
    expect(again.installed).toBe(false);
    expect(again.message).toContain("nothing to do");
    expect(snapshot(home)).toEqual(before);
  });

  it("moves to a newer version in one swap, keeping the release before it for a server still running from it", async () => {
    const { install, releases, key, home, binary } = fixture();
    await install();
    const newer = release(releases, "1.2.4", key.privateKeyPem);
    expect((await install({ version: "1.2.4" })).installed).toBe(true);
    expect(sha256(binary)).toBe(sha256(join(newer, releaseFile(PLATFORM))));
    expect(readdirSync(join(home, "releases")).filter((name) => !name.startsWith(".")).sort().map((name) => name.split("-")[0])).toEqual(["1.2.3", "1.2.4"]);
    release(releases, "1.2.5", key.privateKeyPem);
    expect((await install({ version: "1.2.5" })).installed).toBe(true);
    expect(readdirSync(join(home, "releases")).filter((name) => !name.startsWith(".")).sort().map((name) => name.split("-")[0])).toEqual(["1.2.4", "1.2.5"]);
  });

  const binaryOf = (dir: string) => join(dir, releaseFile(PLATFORM));
  const refusals: [string, (dir: string, privateKeyPem: string) => void, string][] = [
    ["a binary that does not match its SHA-256", (dir) => writeFileSync(binaryOf(dir), readFileSync(binaryOf(dir)).map((byte, index) => (index === 12 ? byte ^ 1 : byte))), "does not match its SHA-256"],
    ["a truncated binary", (dir) => writeFileSync(binaryOf(dir), readFileSync(binaryOf(dir)).subarray(0, 5)), "bytes, not the"],
    ["a binary larger than the manifest says", (dir) => writeFileSync(binaryOf(dir), Buffer.concat([readFileSync(binaryOf(dir)), Buffer.alloc(4096)])), "larger than the"],
    ["a client archive that does not match", (dir) => writeFileSync(join(dir, DIST_ARCHIVE), "x"), DIST_ARCHIVE],
    ["a manifest signed by another key", (dir) => signManifest(dir, generateKeyPair().privateKeyPem), "is not a signature of this ovis-server.json"],
    ["a manifest for another version, signed by the right key", (dir, privateKeyPem) => {
      writeManifest(dir, { version: "1.2.2", sources });
      signManifest(dir, privateKeyPem);
    }, "is for version 1.2.2, not the expected 1.2.4"],
  ];
  for (const [what, spoil, says] of refusals) {
    it(`refuses ${what}, says why, and leaves the previous install byte for byte as it was`, async () => {
      const { install, home, releases, key } = fixture();
      await install();
      const before = snapshot(home);
      spoil(release(releases, "1.2.4", key.privateKeyPem), key.privateKeyPem);
      await expect(install({ version: "1.2.4" })).rejects.toThrow(says);
      expect(snapshot(home)).toEqual(before);
      expect(readdirSync(join(home, "releases")).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    });
  }

  it("refuses a client archive with a path out of its folder, even signed by the right key", async () => {
    const { install, dir, key, root, home } = fixture();
    const outside = join(root, "evil");
    mkdirSync(join(outside, "inner"), { recursive: true });
    writeFileSync(join(outside, "escaped"), "x");
    expect(Bun.spawnSync(["tar", "-czPf", join(dir, DIST_ARCHIVE), "-C", join(outside, "inner"), "../escaped"]).exitCode).toBe(0);
    writeManifest(dir, { version: "1.2.3", sources });
    signManifest(dir, key.privateKeyPem);
    await expect(install()).rejects.toThrow("outside");
    expect(existsSync(join(home, "escaped"))).toBe(false);
    expect(existsSync(join(home, "bin"))).toBe(false);
  });

  it("takes only https:// or a file:// folder as the place releases come from", () => {
    expect(releasesBase(undefined)).toBe("https://github.com/devswha/ovis/releases/download");
    expect(releasesBase("https://mirror.example/ovis/")).toBe("https://mirror.example/ovis");
    expect(releasesBase("file:///srv/release")).toBe("file:///srv/release");
    for (const refused of ["http://mirror.example/ovis", "ftp://mirror.example", "/srv/release", "file://relative"]) expect(() => releasesBase(refused)).toThrow("OVIS_RELEASES_URL");
  });

  it("cleans up what an interrupted install left with the next install, and the install it interrupted still runs", async () => {
    const { install, home, binary, releases, key } = fixture();
    await install();
    const before = sha256(binary);
    mkdirSync(join(home, "releases", ".stage-interrupted"));
    writeFileSync(join(home, "releases", ".stage-interrupted", "ovis-server"), "half");
    expect(sha256(binary)).toBe(before);
    expect((await install()).installed).toBe(false);
    release(releases, "1.2.4", key.privateKeyPem);
    expect((await install({ version: "1.2.4" })).installed).toBe(true);
    expect(readdirSync(join(home, "releases")).filter((name) => name.startsWith(".stage-"))).toEqual([]);
  });


  it("tells a release with no ovis-server.json, and nothing else, as one without a compiled server, writing nothing", async () => {
    const { install, releases, key, home, dir } = fixture();
    let error: unknown = await install({ version: "9.9.9" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(NoBinaryRelease);
    expect(existsSync(join(home, "bin"))).toBe(false);
    signManifest(dir, generateKeyPair().privateKeyPem);
    error = await install().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoBinaryRelease);
    rmSync(join(dir, "ovis-server.json.sig"));
    error = await install().catch((caught) => caught);
    expect(error).not.toBeInstanceOf(NoBinaryRelease);
    release(releases, "1.2.4", key.privateKeyPem);
    expect((await install({ version: "1.2.4" })).installed).toBe(true);
  });

  it("installs again a release whose client went missing", async () => {
    const { install, home, key } = fixture();
    await install();
    rmSync(join(home, "bin", "dist"), { recursive: true });
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBeNull();
    expect((await install()).installed).toBe(true);
    expect(existsSync(join(home, "bin", "dist", "index.html"))).toBe(true);
  });

  it("reads a signed manifest of the shape before schema 1 as no binary release, and refuses a bad signature or an unknown schema", async () => {
    const root = scratch();
    const releases = join(root, "release");
    const key = generateKeyPair();
    oldShape(releases, "0.5.4", key.privateKeyPem);
    oldShape(releases, "0.5.5", generateKeyPair().privateKeyPem);
    oldShape(releases, "0.5.6", key.privateKeyPem, (manifest) => { manifest["schema"] = 2; });
    const install = (version: string) => installServer({ home: join(root, "home"), version, platform: PLATFORM, releases: `file://${releases}`, publicKey: key.publicKey });
    await expect(install("0.5.4")).rejects.toBeInstanceOf(NoBinaryRelease);
    await expect(install("0.5.4")).rejects.toThrow("ships no compiled server this installer runs");
    const badSignature = await install("0.5.5").catch((error: unknown) => error);
    expect(badSignature).not.toBeInstanceOf(NoBinaryRelease);
    expect(String(badSignature)).toContain("not a signature");
    const newer = await install("0.5.6").catch((error: unknown) => error);
    expect(newer).not.toBeInstanceOf(NoBinaryRelease);
    expect(String(newer)).toContain("schema 2");
    expect(existsSync(join(root, "home", "bin"))).toBe(false);
  });

  it("takes the binary only for the sources it was built from: another checkout's trees, or uncommitted changes, are no binary release", async () => {
    const { releases, home, key } = fixture();
    const install = (sources: { server: string; shared: string } | { error: string }, at = `file://${releases}`, fetchFile?: typeof fetch) =>
      installServer({ home, version: "1.2.3", platform: PLATFORM, releases: at, publicKey: key.publicKey, sources, fetchFile });
    await expect(install({ server: "c".repeat(40), shared: "b".repeat(40) })).rejects.toBeInstanceOf(NoBinaryRelease);
    const asked: string[] = [];
    const offline = (async (url: string | URL | Request) => { asked.push(String(url)); throw new TypeError("fetch failed"); }) as typeof fetch;
    const untied = await install({ error: "git is not on PATH, so the binaries cannot be tied to their sources" }, "https://releases.invalid", offline).catch((error: unknown) => error);
    expect(untied).toBeInstanceOf(NoBinaryRelease);
    expect(String(untied)).toContain("git is not on PATH");
    await expect(install({ error: "server/ or shared/ has changes that are not committed" })).rejects.toBeInstanceOf(NoBinaryRelease);
    expect(asked).toEqual([]);
    expect(existsSync(join(home, "bin"))).toBe(false);
    expect((await install({ server: "a".repeat(40), shared: "b".repeat(40) })).installed).toBe(true);
    expect(await install({ error: "git is not on PATH, so the binaries cannot be tied to their sources" }, "https://releases.invalid", offline)).toMatchObject({ installed: false });
    expect(asked).toEqual([]);
  });

  it("takes only the PTY host the signed manifest names: a tampered ovis-pty-sidecar.json is not read, a replaced host never runs", async () => {
    const root = scratch();
    const releases = join(root, "release");
    const key = generateKeyPair();
    const dir = release(releases, "1.2.3", key.privateKeyPem, undefined, "the signed host\n");
    writeFileSync(join(dir, "ovis-pty-sidecar.json"), JSON.stringify({ version: "1.2.3", crate: "c".repeat(40), assets: {} }));
    const ran: string[] = [];
    const install = (home: string) => installServer({ home, version: "1.2.3", platform: PLATFORM, releases: `file://${releases}`, publicKey: key.publicKey,
      ptyRuns: (path) => { ran.push(readFileSync(path, "utf8")); return true; } });
    const first = await install(join(root, "home"));
    expect(first.message).toContain("the Rust PTY host checked against ovis-server.json");
    expect(ran).toEqual(["the signed host\n"]);
    expect(JSON.parse(readFileSync(join(root, "home", "bin", "bin", "ovis-pty-sidecar.json"), "utf8")).sha256)
      .toBe(createHash("sha256").update("the signed host\n").digest("hex"));
    writeFileSync(join(dir, ptyFile("linux-x64")), "a mirror's host\n");
    const second = await install(join(root, "other"));
    expect(second.installed).toBe(true);
    expect(second.message).toContain("the Rust PTY host was not taken");
    expect(ran).toEqual(["the signed host\n"]);
    expect(existsSync(join(root, "other", "bin", "bin", "ovis-pty-sidecar"))).toBe(false);
  });

  it("hashes the binary again whenever its size, mtime or inode changed since it was last found whole", async () => {
    const { install, home, key, binary } = fixture();
    await install();
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBe(binary);
    expect(existsSync(join(home, ".verified.json"))).toBe(true);
    const bytes = readFileSync(binary);
    bytes[bytes.length - 2] ^= 1;
    writeFileSync(binary, bytes);
    utimesSync(binary, new Date(), new Date(Date.now() + 5_000));
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBeNull();
  });

  it("hashes the binary again after a rename puts other bytes of the same size and mtime in its place", async () => {
    const { install, home, key, binary } = fixture();
    await install();
    const mtime = new Date(1_700_000_000_000), atime = mtime;
    utimesSync(binary, atime, mtime);
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBe(binary);
    const bytes = readFileSync(binary);
    bytes[bytes.length - 2] ^= 1;
    const other = `${binary}.other`;
    writeFileSync(other, bytes, { mode: 0o755 });
    utimesSync(other, atime, mtime);
    renameSync(other, binary);
    expect(statSync(binary).size).toBe(bytes.length);
    expect(statSync(binary).mtimeMs).toBe(mtime.getTime());
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBeNull();
  });

  it("runs an installed release only while its kept manifest still verifies and the binary matches it", async () => {
    const { install, home, key, binary } = fixture();
    await install();
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBe(binary);
    expect(verifiedInstall(home, "1.2.4", PLATFORM, key.publicKey)).toBeNull();
    expect(verifiedInstall(home, "1.2.3", PLATFORM, generateKeyPair().publicKey)).toBeNull();
    writeFileSync(binary, "#!/bin/sh\necho swapped\n");
    expect(verifiedInstall(home, "1.2.3", PLATFORM, key.publicKey)).toBeNull();
    expect((await install()).installed).toBe(true);
  });

  it("never leaves bin without a whole release when two installs overlap", async () => {
    const { install, releases, key, home } = fixture();
    const shas = new Map(["1.2.3", "1.2.4"].map((version) => [sha256(join(release(releases, version, key.privateKeyPem), releaseFile(PLATFORM))), version]));
    for (let pair = 0; pair < 10; pair++) {
      const results = await Promise.allSettled([install({ version: pair % 2 ? "1.2.3" : "1.2.4" }), install({ version: pair % 2 ? "1.2.4" : "1.2.3" })]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      const version = shas.get(sha256(join(home, "bin", "ovis-server")));
      expect(version, `pair ${pair}`).toBeDefined();
      expect(readFileSync(join(home, "bin", "dist", "index.html"), "utf8")).toBe("<!doctype html>");
      expect(existsSync(join(home, ".install.lock"))).toBe(false);
    }
  });

  it("lets a second install in only after the first has swapped bin, not into its window", async () => {
    const { releases, key, home } = fixture();
    release(releases, "1.2.4", key.privateKeyPem);
    const events: string[] = [];
    let secondIn = false;
    let waited!: () => void;
    const secondWaits = new Promise<void>((resolve) => { waited = resolve; });
    const install = (version: string, hold: boolean) => installServer({
      home, version, platform: PLATFORM, releases: `file://${releases}`, publicKey: key.publicKey, onLockWait: hold ? undefined : waited,
      inWindow: async () => {
        events.push(`${version} in`);
        if (!hold) secondIn = true;
        if (hold) await Promise.race([secondWaits, new Promise<void>((resolve) => { const check = setInterval(() => { if (secondIn) { clearInterval(check); resolve(); } }, 10); })]);
        events.push(`${version} out`);
      },
    });
    await Promise.all([install("1.2.3", true), install("1.2.4", false)]);
    expect(events).toEqual(["1.2.3 in", "1.2.3 out", "1.2.4 in", "1.2.4 out"]);
    expect(readFileSync(join(home, "bin", MANIFEST), "utf8")).toContain('"version": "1.2.4"');
  });

  it("takes over the lock of an install that died, and waits out a live one's", async () => {
    const { install, home } = fixture();
    const lock = join(home, ".install.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim()}\n`);
    expect((await install()).installed).toBe(true);
    expect(existsSync(lock)).toBe(false);
    rmSync(join(home, "bin", MANIFEST));
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    await expect(install({ lockWaitMs: 300 })).rejects.toThrow(`another install is running in ${home} (pid ${process.pid})`);
    expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(process.pid));
  });
});

describe("downloading a release file", () => {
  it("is null only for a file that is not there (404), and a failure for a server error", async () => {
    const answer = (status: number) => (async () => new Response(status === 200 ? "x" : null, { status })) as unknown as typeof fetch;
    expect(await download("https://example.invalid/ovis-server.json", 100, "ovis-server.json", answer(404))).toBeNull();
    await expect(download("https://example.invalid/ovis-server.json", 100, "ovis-server.json", answer(500))).rejects.toThrow("HTTP 500");
    expect(new TextDecoder().decode((await download("https://example.invalid/a", 100, "a", answer(200)))!)).toBe("x");
  });

  it("refuses a redirect off https before it makes a single plain request", async () => {
    let plainHits = 0;
    const plain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { plainHits++; return new Response("x"); } });
    try {
      const target = `http://127.0.0.1:${plain.port}/ovis-server.json`;
      // as fetch does: a redirect it is not told to hand back is followed at once
      const fetchFile = (async (url: string | URL | Request, init?: RequestInit) => !String(url).startsWith("https://") ? fetch(url, init)
        : init?.redirect === "manual" ? new Response(null, { status: 302, headers: { location: target } })
        : fetch(target)) as typeof fetch;
      await expect(download("https://example.invalid/ovis-server.json", 100, "ovis-server.json", fetchFile)).rejects.toThrow("which is not https");
      expect(plainHits).toBe(0);
    } finally {
      plain.stop(true);
    }
  });
});
