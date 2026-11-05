import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { architectures, crateTree, expectedArchitectures, install, TREE_RELEASE, type Manifest } from "./pty-sidecar.ts";

const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
const HOST = "#!/bin/sh\nprintf 'pty-sidecar: usage: fixture\\n' >&2\nexit 2\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("install", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pty-sidecar-install-"));
  const files = new Map<string, string>();
  let server: ReturnType<typeof Bun.serve>;
  let releases = "";
  const sources = crateTree();
  const tree = "tree" in sources ? sources.tree : "";
  const publish = (binary: string, manifest: Partial<Manifest> = {}) => {
    files.set(`/v${version}/ovis-pty-sidecar-linux-x64`, binary);
    files.set(`/v${version}/ovis-pty-sidecar.json`, JSON.stringify({
      version, crate: tree, assets: { "linux-x64": { file: "ovis-pty-sidecar-linux-x64", sha256: sha256(HOST) } }, ...manifest,
    }));
  };
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
      const body = files.get(new URL(request.url).pathname);
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    } });
    releases = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { void server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const target = () => join(dir, crypto.randomUUID(), "ovis-pty-sidecar");

  it("installs the release's binary when its SHA-256 and crate tree match, and keeps it on a rerun", async () => {
    publish(HOST);
    const path = target();
    const first = await install({ releases, target: path, platform: "linux-x64" });
    expect(first.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(HOST);
    const again = await install({ releases, target: path, platform: "linux-x64" });
    expect(again).toEqual({ ok: true, message: expect.stringContaining("already installed") });
  });

  it("refuses a binary whose SHA-256 differs from the manifest, leaving nothing behind", async () => {
    publish(`${HOST}# tampered\n`);
    const path = target();
    const result = await install({ releases, target: path, platform: "linux-x64" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match its SHA-256");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(path, ".."))).toBe(false);
  });

  it("refuses a release built from other crate sources", async () => {
    publish(HOST, { crate: "0".repeat(40) });
    const path = target();
    const result = await install({ releases, target: path, platform: "linux-x64" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("other crates/pty-sidecar sources");
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a binary that does not run as the host, leaving nothing behind", async () => {
    const other = "#!/bin/sh\nexit 0\n";
    publish(other, { assets: { "linux-x64": { file: "ovis-pty-sidecar-linux-x64", sha256: sha256(other) } } });
    const path = target();
    const result = await install({ releases, target: path, platform: "linux-x64" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not run on this PC");
    expect(existsSync(path)).toBe(false);
  });

  it("removes a host in place that a failed install cannot vouch for, and keeps the verified one", async () => {
    publish(HOST);
    const path = target();
    expect((await install({ releases, target: path, platform: "linux-x64" })).ok).toBe(true);
    files.clear();
    const offline = await install({ releases, target: path, platform: "linux-x64" });
    expect(offline.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(HOST);
    writeFileSync(path, `${HOST}# replaced\n`);
    const stale = await install({ releases, target: path, platform: "linux-x64" });
    expect(stale.message).toContain("removed the unverified");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.json`)).toBe(false);
  });

  it("refuses a manifest that is not one for this version, without throwing", async () => {
    for (const body of ["null", "[]", JSON.stringify({ version: "0.0.0", crate: tree, assets: {} }), JSON.stringify({ version, crate: tree, assets: { "linux-x64": null } })]) {
      files.set(`/v${version}/ovis-pty-sidecar.json`, body);
      const result = await install({ releases, target: target(), platform: "linux-x64" });
      expect(result.ok).toBe(false);
    }
  });

  it("turns a PC without git into a failed result instead of throwing", async () => {
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw Object.assign(new Error("Executable not found in $PATH: \"git\""), { code: "ENOENT" }); });
    try {
      const result = await install({ releases, target: target(), platform: "linux-x64" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("git");
    } finally { spawn.mockRestore(); }
  });

  it("turns a filesystem failure into a failed result instead of throwing", async () => {
    publish(HOST);
    const blocked = join(dir, crypto.randomUUID());
    writeFileSync(blocked, "a file where the directory would go");
    const result = await install({ releases, target: join(blocked, "ovis-pty-sidecar"), platform: "linux-x64" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not install");
  });

  it("takes the host built from these sources from their crate tree's prerelease when the release's is from others", async () => {
    files.clear();
    publish(HOST, { crate: "0".repeat(40) });
    const built = (binary: string, crate = tree) => {
      files.set(`/${TREE_RELEASE}${tree}/ovis-pty-sidecar-linux-x64`, binary);
      // a beta's manifest says main's version then, which need not be this checkout's
      files.set(`/${TREE_RELEASE}${tree}/ovis-pty-sidecar.json`, JSON.stringify({
        version: "0.0.1", crate, assets: { "linux-x64": { file: "ovis-pty-sidecar-linux-x64", sha256: sha256(HOST) } },
      }));
    };
    built(HOST);
    const path = target();
    const result = await install({ releases, target: path, platform: "linux-x64" });
    expect(result).toEqual({ ok: true, message: expect.stringContaining(`prerelease ${TREE_RELEASE}`) });
    expect(readFileSync(path, "utf8")).toBe(HOST);
    expect(JSON.parse(readFileSync(`${path}.json`, "utf8"))).toMatchObject({ crate: tree, version });

    // checked the same way: other sources, or a binary that is not the manifest's, install nothing
    built(HOST, "1".repeat(40));
    expect((await install({ releases, target: target(), platform: "linux-x64" })).ok).toBe(false);
    built(`${HOST}# tampered\n`);
    const tampered = await install({ releases, target: target(), platform: "linux-x64" });
    expect(tampered.ok).toBe(false);
    expect(tampered.message).toContain("does not match its SHA-256");
  });

  it("says so when the release has no host, or the platform has none", async () => {
    files.clear();
    expect((await install({ releases, target: target(), platform: "linux-x64" })).message).toContain("HTTP 404");
    expect((await install({ releases, target: target(), platform: "win32-x64" })).message).toContain("no Rust PTY host for win32-x64");
  });
});

describe("pty-sidecar-attach.sh", () => {
  const ATTACH = join(import.meta.dir, "pty-sidecar-attach.sh");
  /** runs the attach script against a fake gh whose `release view` answers `view` (an asset list) or fails; returns what gh was asked to upload */
  function attach(view: string | null): { code: number; uploads: string[]; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "ovis-pty-attach-"));
    try {
      const set = join(dir, "set");
      mkdirSync(set);
      writeFileSync(join(set, "ovis-pty-sidecar.json"), JSON.stringify({ version }));
      for (const name of ["ovis-pty-sidecar-linux-x64", "SHA256SUMS"]) writeFileSync(join(set, name), "x");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const log = join(dir, "gh.log");
      const assets = join(dir, "assets.txt");
      if (view !== null) writeFileSync(assets, `${view}\n`);
      const answer = view === null ? `echo "HTTP 502: Bad Gateway" >&2; exit 1` : `cat "${assets}"`;
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$2" in view) ${answer} ;; upload) exit 0 ;; esac\n`, { mode: 0o755 });
      const run = Bun.spawnSync(["bash", ATTACH, `v${version}`, set], { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` }, stdout: "pipe", stderr: "pipe" });
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { code: run.exitCode, uploads: calls.filter((call) => call.startsWith("release upload")), stderr: run.stderr.toString() };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it("uploads nothing when the release lookup fails, so a complete set is never half replaced", () => {
    const result = attach(null);
    expect(result.code).toBe(1);
    expect(result.uploads).toEqual([]);
    expect(result.stderr).toContain("nothing was uploaded");
  });

  it("uploads nothing to a release that already has the host", () => {
    const result = attach("ovis-pty-sidecar-linux-x64\novis-pty-sidecar.json");
    expect(result.code).toBe(1);
    expect(result.uploads).toEqual([]);
  });

  it("uploads the binaries before the manifest to a release without the host", () => {
    const result = attach("Ovis.dmg");
    expect(result.code).toBe(0);
    expect(result.uploads).toHaveLength(2);
    expect(result.uploads[0]).toContain("--clobber");
    expect(result.uploads[1]).toMatch(/ovis-pty-sidecar\.json$/);
  });
});

describe("crateTree", () => {
  it("refuses crate sources that differ from HEAD", () => {
    const repo = mkdtempSync(join(tmpdir(), "ovis-pty-sidecar-git-"));
    try {
      const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo }).exitCode).toBe(0);
      git("init", "-q");
      mkdirSync(join(repo, "crates/pty-sidecar/src"), { recursive: true });
      writeFileSync(join(repo, "crates/pty-sidecar/src/main.rs"), "fn main() {}\n");
      git("add", ".");
      git("commit", "-qm", "crate");
      expect("tree" in crateTree(repo)).toBe(true);
      writeFileSync(join(repo, "crates/pty-sidecar/src/main.rs"), "fn main() { loop {} }\n");
      expect(crateTree(repo)).toEqual({ error: expect.stringContaining("not committed") });
      git("checkout", "-q", "--", ".");
      writeFileSync(join(repo, "crates/pty-sidecar/src/extra.rs"), "");
      expect(crateTree(repo)).toEqual({ error: expect.stringContaining("not committed") });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("architectures", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pty-sidecar-arch-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (bytes: Buffer) => {
    const path = join(dir, crypto.randomUUID());
    writeFileSync(path, Buffer.concat([bytes, Buffer.alloc(64)]));
    return path;
  };

  it("reads ELF and Mach-O headers, every slice of a universal file, and expects them per target", () => {
    const elf = Buffer.alloc(20);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf.writeUInt16LE(0xb7, 18);
    expect(architectures(file(elf))).toEqual(["elf-aarch64"]);
    const fat = Buffer.alloc(48);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(0x01000007, 28);
    expect(architectures(file(fat)).sort()).toEqual(expectedArchitectures(["aarch64-apple-darwin", "x86_64-apple-darwin"]));
    expect(expectedArchitectures(["x86_64-unknown-linux-musl"])).toEqual(["elf-x86_64"]);
    expect(architectures(file(Buffer.from("#!/bin/sh\n")))).toEqual(["unknown"]);
  });
});
