import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC as DESKTOP_HC, HC_VERSION as DESKTOP_HC_VERSION } from "../../app/electron/scripts/runtimes.ts";
import { HC_RELEASE, installHc, type HcRelease } from "./install.ts";

describe.skipIf(process.platform === "win32")("installing herdr-core for the move", () => {
  let root: string;
  let home: string;
  let archive: Uint8Array;
  let fetched: string[];
  let packs = 0;
  const target = `${process.platform}-${process.arch}`;
  const ARCHIVE_URL = "https://releases.example.test/core/9.9.9/herdr-core.tar.gz";

  const pack = (answer: string): Uint8Array => {
    const dir = join(root, `pack-${++packs}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "herdr-core"), `#!/bin/sh\n[ "$1" = --version ] && echo "${answer}"\n`);
    chmodSync(join(dir, "herdr-core"), 0o755);
    writeFileSync(join(dir, "LICENSE"), "license");
    const out = join(root, `pack-${packs}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", out, "-C", dir, "herdr-core", "LICENSE"]);
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
    return readFileSync(out);
  };
  const release = (bytes: Uint8Array): HcRelease => ({ version: "9.9.9", targets: { [target]: { url: ARCHIVE_URL, sha256: createHash("sha256").update(bytes).digest("hex") } } });
  const serve = (bytes: Uint8Array) => (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  }) as typeof fetch;
  const bin = () => join(home, ".local", "bin");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-hc-install-"));
    home = join(root, "home");
    mkdirSync(home);
    fetched = [];
    archive = pack("hc 9.9.9");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("installs the pinned archive into ~/.local/bin as herdr-core, with hc linked beside it", async () => {
    const { path: dest } = await installHc({ home, env: { PATH: "/nonexistent" }, release: release(archive), fetch: serve(archive) });
    expect(dest).toBe(join(bin(), "herdr-core"));
    expect(fetched).toEqual([ARCHIVE_URL]);
    expect(lstatSync(dest).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([dest, "--version"]).stdout.toString().trim()).toBe("hc 9.9.9");
    expect(readlinkSync(join(bin(), "hc"))).toBe("herdr-core");
    expect(readdirSync(bin()).sort()).toEqual(["hc", "herdr-core"]);
  });

  it("leaves an hc already on the PATH alone", async () => {
    mkdirSync(join(root, "wm"));
    writeFileSync(join(root, "wm", "hc"), "#!/bin/sh\n");
    chmodSync(join(root, "wm", "hc"), 0o755);
    await installHc({ home, env: { PATH: join(root, "wm") }, release: release(archive), fetch: serve(archive) });
    expect(readdirSync(bin())).toEqual(["herdr-core"]);
  });

  it("installs nothing when the download does not match its checksum", async () => {
    const other = pack("hc 9.9.9 tampered");
    await expect(installHc({ home, env: { PATH: "/nonexistent" }, release: release(archive), fetch: serve(other) })).rejects.toThrow(/checksum/);
    expect(existsSync(bin())).toBe(false);
  });

  it("installs nothing when the program does not answer as that hc", async () => {
    const wrong = pack("hc 0.0.1");
    await expect(installHc({ home, env: { PATH: "/nonexistent" }, release: release(wrong), fetch: serve(wrong) })).rejects.toThrow(/does not run here/);
    expect(existsSync(bin())).toBe(false);
  });

  it("never replaces a herdr-core already in ~/.local/bin, even one that does not answer", async () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(bin(), "herdr-core"), "mine");
    await expect(installHc({ home, env: { PATH: "/nonexistent" }, release: release(archive), fetch: serve(archive) })).rejects.toThrow(/already there/);
    expect(fetched).toEqual([]);
    expect(readFileSync(join(bin(), "herdr-core"), "utf8")).toBe("mine");
    expect(readdirSync(bin())).toEqual(["herdr-core"]);
  });

  it("stops reading a download past the size cap, without holding it all", async () => {
    let sent = 0;
    const endless = (async () => {
      fetched.push(ARCHIVE_URL);
      return new Response(new ReadableStream({ pull(controller) { sent += 1 << 20; controller.enqueue(new Uint8Array(1 << 20)); } }));
    }) as unknown as typeof fetch;
    await expect(installHc({ home, env: { PATH: "/nonexistent" }, release: release(archive), fetch: endless })).rejects.toThrow(/far larger/);
    expect(sent).toBeLessThan(80 << 20);
    expect(existsSync(bin())).toBe(false);
  });

  it("takes out only what it installed when undone", async () => {
    const installed = await installHc({ home, env: { PATH: "/nonexistent" }, release: release(archive), fetch: serve(archive) });
    installed.undo();
    expect(readdirSync(bin())).toEqual([]);
    const again = await installHc({ home, env: { PATH: "/nonexistent" }, release: release(archive), fetch: serve(archive) });
    rmSync(again.path);
    writeFileSync(again.path, "mine");
    again.undo();
    expect(readdirSync(bin())).toEqual(["herdr-core"]);
  });

  it("installs nothing where herdr-core has no build", async () => {
    await expect(installHc({ home, platform: "linux", arch: "ia32", release: release(archive), fetch: serve(archive) })).rejects.toThrow(/no build/);
    expect(fetched).toEqual([]);
  });
});

it("pins the same herdr-core as the desktop app carries", () => {
  expect(HC_RELEASE.version).toBe(DESKTOP_HC_VERSION);
  const desktop = { "linux-x64": DESKTOP_HC["linux-x64"], "linux-arm64": DESKTOP_HC["linux-arm64"], "darwin-x64": DESKTOP_HC["darwin-x64"], "darwin-arm64": DESKTOP_HC["darwin-arm64"] };
  expect(HC_RELEASE.targets).toEqual(desktop);
});
