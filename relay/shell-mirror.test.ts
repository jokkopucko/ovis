import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP, mirrorOnce, REPOSITORY } from "./shell-mirror.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-shell-mirror-"));
  dirs.push(dir);
  return dir;
}

const LIVE = "a".repeat(40);
const OLDER = "b".repeat(40);

async function tarball(revision: string, index = "<!doctype html>", extra: Record<string, string> = {}): Promise<Uint8Array> {
  const src = temp();
  writeFileSync(join(src, "build.json"), JSON.stringify({ revision }));
  writeFileSync(join(src, "index.html"), index);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(src, name), body);
  const out = join(temp(), "dist-shell.tar.gz");
  await Bun.$`tar -czf ${out} -C ${src} .`.quiet();
  return new Uint8Array(readFileSync(out));
}

function github(releases: { tag: string; commit: string; archive?: Uint8Array; digest?: string }[], live = LIVE,
  served: Record<string, string> = { "index.html": "<!doctype html>" }, lives: string[] = [], later = false) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url === `${APP}/build.json`) return Response.json({ revision: lives.shift() ?? live });
    const path = url.startsWith(`${APP}/`) ? url.slice(APP.length + 1) : undefined;
    if (path !== undefined && served[path] !== undefined) return new Response(served[path]);
    const tags = /\/tags\?per_page=100&page=(\d+)$/.exec(url);
    if (tags && url.startsWith(`https://api.github.com/repos/${REPOSITORY}/`)) {
      const newer = Array.from({ length: later ? 100 : 0 }, (_, i) => ({ name: `v9.${i}`, commit: { sha: "c".repeat(40) } }));
      const all = [...newer, ...releases.map(({ tag, commit }) => ({ name: tag, commit: { sha: commit } }))];
      const page = Number(tags[1]);
      return Response.json(all.slice((page - 1) * 100, page * 100));
    }
    for (const release of releases) {
      if (url === `https://api.github.com/repos/${REPOSITORY}/releases/tags/${release.tag}`) {
        return Response.json({ tag_name: release.tag, assets: release.archive ? [
          { name: "dist-shell.tar.gz", browser_download_url: `https://dl.test/${release.tag}/dist-shell.tar.gz` },
          { name: "dist-shell.tar.gz.sha256", browser_download_url: `https://dl.test/${release.tag}/dist-shell.tar.gz.sha256` },
        ] : [] });
      }
      if (url === `https://dl.test/${release.tag}/dist-shell.tar.gz` && release.archive) return new Response(new Blob([release.archive.slice()]));
      if (url === `https://dl.test/${release.tag}/dist-shell.tar.gz.sha256` && release.archive) {
        return new Response(`${release.digest ?? createHash("sha256").update(release.archive).digest("hex")}  dist-shell.tar.gz\n`);
      }
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

it("serves the release built from the commit app.ovis.sh serves, and does nothing once it does", async () => {
  const dir = temp();
  const { fetcher } = github([
    { tag: "v0.4.23", commit: OLDER, archive: await tarball(OLDER) },
    { tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE, "live") },
  ], LIVE, { "index.html": "live" });
  expect(await mirrorOnce({ dir, fetch: fetcher })).toEqual({ kind: "updated", tag: "v0.4.22", revision: LIVE });
  expect(readlinkSync(join(dir, "current"))).toMatch(/^releases\/v0\.4\.22\+/);
  expect(readFileSync(join(dir, "current", "index.html"), "utf8")).toBe("live");
  expect(await mirrorOnce({ dir, fetch: fetcher })).toEqual({ kind: "current", revision: LIVE });
});

it("refuses a tarball that does not match its published SHA-256, and keeps serving what it served", async () => {
  const dir = temp();
  const first = github([{ tag: "v0.4.21", commit: OLDER, archive: await tarball(OLDER) }], OLDER);
  await mirrorOnce({ dir, fetch: first.fetcher });
  const tampered = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE), digest: "0".repeat(64) }]);
  await expect(mirrorOnce({ dir, fetch: tampered.fetcher })).rejects.toThrow("published SHA-256");
  expect(readlinkSync(join(dir, "current"))).toMatch(/^releases\/v0\.4\.21\+/);
});

it("refuses a release whose build.json names another commit than its tag", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(OLDER) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("not " + LIVE);
  expect(() => readlinkSync(join(dir, "current"))).toThrow();
});

it.skipIf(process.platform === "win32")("refuses a tarball that holds a link", async () => {
  const dir = temp();
  const src = temp();
  writeFileSync(join(src, "build.json"), JSON.stringify({ revision: LIVE }));
  mkdirSync(join(src, "assets"));
  await Bun.$`ln -s /etc/passwd ${join(src, "assets", "x")}`.quiet();
  const out = join(temp(), "dist-shell.tar.gz");
  await Bun.$`tar -czf ${out} -C ${src} .`.quiet();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: new Uint8Array(readFileSync(out)) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("link");
});

it("serves nothing when no release was built from that commit, and does not ask GitHub again for a while", async () => {
  const dir = temp();
  const { fetcher, asked } = github([{ tag: "v0.4.21", commit: OLDER, archive: await tarball(OLDER) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("no release");
  const calls = asked.length;
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("no release");
  expect(asked.slice(calls).filter((url) => url.startsWith("https://api.github.com"))).toEqual([]);
});

it("refuses a release asset that differs from what app.ovis.sh serves, though its SHA-256 matches", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE, "<script>steal()</script>") }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("index.html differs");
  expect(() => readlinkSync(join(dir, "current"))).toThrow();
});

it("makes nothing current when app.ovis.sh moved on during the run", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE) }], LIVE, undefined, [LIVE, LIVE, OLDER]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("changed while");
  expect(() => readlinkSync(join(dir, "current"))).toThrow();
});

it("drops precompressed copies, which app.ovis.sh does not serve as files", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE, "<!doctype html>", { "index.html.br": "x", _headers: "/*" }) }]);
  await mirrorOnce({ dir, fetch: fetcher });
  expect(() => readFileSync(join(dir, "current", "index.html.br"))).toThrow();
  expect(readFileSync(join(dir, "current", "_headers"), "utf8")).toBe("/*");
});

it("finds a release whose tag is past the first page of tags", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE) }], LIVE, undefined, [], true);
  expect(await mirrorOnce({ dir, fetch: fetcher })).toMatchObject({ kind: "updated", tag: "v0.4.22" });
});

it("looks again on the next run for a tagged release whose shell is not attached yet", async () => {
  const dir = temp();
  const { fetcher, asked } = github([{ tag: "v0.4.22", commit: LIVE }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("no dist-shell.tar.gz yet");
  const calls = asked.length;
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("no dist-shell.tar.gz yet");
  expect(asked.slice(calls).some((url) => url.includes("/releases/tags/v0.4.22"))).toBe(true);
});

it("refuses to run while another run holds the folder", async () => {
  const dir = temp();
  mkdirSync(join(dir, ".lock"));
  const { fetcher, asked } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("another run");
  expect(asked).toEqual([]);
});

it("installs the same release again beside the one it serves, and keeps the newest copies", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE) }]);
  const served: string[] = [];
  for (let run = 0; run < 5; run++) {
    await mirrorOnce({ dir, fetch: fetcher });
    served.push(readlinkSync(join(dir, "current")));
    rmSync(join(dir, "current", "build.json"));
    await Bun.sleep(2);
  }
  expect(new Set(served).size).toBe(5);
  const kept = readdirSync(join(dir, "releases")).sort();
  expect(kept).toEqual(served.slice(-3).map((link) => link.slice("releases/".length)).sort());
});
