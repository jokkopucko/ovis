import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLE_PLATFORMS, BUNDLE_WORKFLOW, bundleInput, bunPins, bundleProblems, check, DEPLOYED_FILE, type Get, manifestUrl, publishedProblems, releaseCheck, WORKER_SOURCES, workerFingerprint, workerProblems } from "./release-guards.ts";
import { bundleManifestSource } from "../server/remote-bundle.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";

const made: string[] = [];
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const run = (dir: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-C", dir, ...ID, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
};
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("bundleProblems", () => {
  it("passes a bundle published from these inputs, or one raised and not yet published", () => {
    expect(bundleProblems({ version: 27, published: [26, 27], changed: [], publishing: false })).toEqual([]);
    expect(bundleProblems({ version: 28, published: [26, 27], changed: null, publishing: false })).toEqual([]);
    expect(bundleProblems({ version: 27, published: [26, 27], changed: [], publishing: true })).toEqual([]);
  });

  it("fails a release whose server changed under a bundle number that is already published", () => {
    const [problem] = bundleProblems({ version: 27, published: [27], changed: ["server/index.ts"], publishing: false });
    expect(problem).toContain("server/index.ts");
    expect(problem).toContain("from 27 to 28");
  });

  it("fails the Release run until the raised bundle is published, and a number below a published one", () => {
    expect(bundleProblems({ version: 28, published: [27], changed: null, publishing: true })[0]).toContain("Push the tag remote-v28");
    expect(bundleProblems({ version: 26, published: [27], changed: [], publishing: false })[0]).toContain("raise it to 28");
  });

  it("counts what the bundle runs, not its tests, docs or fixtures", () => {
    expect(["server/index.ts", "shared/machines.ts", "integrations/gjc.ts", "bun.lock", "patches/x.patch", "scripts/build-remote-bundle.ts", "scripts/server-artifact.ts", "scripts/install-gjc-integration.ts", "scripts/install-pi-integration.ts", "integrations/pi-ask.ts", "scripts/pty-sidecar.ts", "crates/pty-sidecar/src/main.rs", "crates/pty-sidecar/Cargo.lock"].every(bundleInput)).toBe(true);
    expect(["server/index.test.ts", "integrations/gjc.test.ts", "scripts/install-gjc-integration.test.ts", "scripts/install-pi-integration.test.ts", "server/AGENTS.md", "server/fixtures/a.json", "src/App.tsx", "serverless.ts", "scripts/release-notes.ts", "crates/pty-sidecar/README.md"].some(bundleInput)).toBe(false);
  });
});

describe("publishedProblems", () => {
  const github = (files: Record<string, unknown>): Get => async (url, init) => {
    if (init.method === "HEAD") return new Response(null, { status: 200 });
    if (!(url in files)) return new Response("Not Found", { status: 404 });
    const file = files[url];
    if (typeof file === "number") return new Response("x", { status: 206, headers: { "content-range": `bytes 0-0/${file}` } });
    return new Response(typeof file === "string" ? file : JSON.stringify(file), { status: 200 });
  };
  const asset = (platform: string) => `https://github.com/devswha/ovis/releases/download/remote-v39/herdr-web-ui-${platform}.tgz`;
  const manifest = (version: string, platforms = BUNDLE_PLATFORMS) => ({ version, assets: Object.fromEntries(platforms.map((platform) => [platform, { url: asset(platform), sha256: "a".repeat(64) }])) });
  const archives: Record<string, number> = Object.fromEntries(BUNDLE_PLATFORMS.map((platform) => [asset(platform), 214_845_782]));

  it("reads the manifest URL remote PCs download, for every platform the bundle workflow publishes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hwc-bundles-"));
    made.push(directory);
    for (const platform of BUNDLE_PLATFORMS) expect(await bundleManifestSource(platform, { directory, manifest: "" })).toBe(manifestUrl(Number(REMOTE_BUNDLE_VERSION)));
    const published = /assert len\(result\['assets'\]\) == (\d+)/.exec(readFileSync(join(import.meta.dir, "..", BUNDLE_WORKFLOW), "utf8"))?.[1];
    expect(BUNDLE_PLATFORMS).toHaveLength(Number(published));
  });

  it("passes a bundle whose manifest and archives are all published", async () => {
    expect(await publishedProblems(39, github({ [manifestUrl(39)]: manifest("39"), ...archives }))).toEqual([]);
  });

  it("fails a bundle that is only tagged, while its workflow has not published the manifest", async () => {
    const [problem] = await publishedProblems(39, github(archives));
    expect(problem).toContain("remote-v39 is tagged but not published");
    expect(problem).toContain(`${manifestUrl(39)} answered 404`);
    const offline: Get = async () => { throw new Error("getaddrinfo ENOTFOUND github.com"); };
    expect((await publishedProblems(39, offline))[0]).toContain("ENOTFOUND");
  });

  it("fails a manifest of another version, one missing a platform, and an archive that cannot be downloaded", async () => {
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: manifest("38"), ...archives })))[0]).toContain('names version "38"');
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: null, ...archives })))[0]).toContain("names version null");
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: manifest("39", BUNDLE_PLATFORMS.slice(1)), ...archives })))[0]).toContain("no bundle for linux-x64");
    const { [asset("win32-x64")]: _, ...partial } = archives;
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: manifest("39"), ...partial })))[0]).toContain(`${asset("win32-x64")} answered 404`);
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: manifest("39"), ...archives, [asset("linux-arm64")]: 0 })))[0]).toContain(`${asset("linux-arm64")} is empty`);
  });

  it("fails an archive that announces its size but never delivers its first byte", async () => {
    const broken = (body: () => ReadableStream<Uint8Array> | null): Get => async (url, init) => {
      if (url === manifestUrl(39)) return github({ [manifestUrl(39)]: manifest("39") })(url, init);
      return new Response(body(), { status: 206, headers: { "content-range": "bytes 0-0/100" } });
    };
    const failing = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("connection reset")); } });
    expect((await publishedProblems(39, broken(failing)))[0]).toContain(`${asset("linux-x64")} failed before its first byte (connection reset)`);
    expect((await publishedProblems(39, broken(() => null)))[0]).toContain(`${asset("linux-x64")} is empty`);
    expect((await publishedProblems(39, broken(() => new ReadableStream({ start(controller) { controller.close(); } }))))[0]).toContain(`${asset("linux-x64")} is empty`);
  });

  it("passes an archive of undeclared size once its first byte arrives, and fails one that declares zero bytes", async () => {
    const whole = (headers: Record<string, string>): Get => async (url, init) => {
      if (url === manifestUrl(39)) return github({ [manifestUrl(39)]: manifest("39") })(url, init);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }), { status: 200, headers });
    };
    const response = await whole({})(asset("linux-x64"), {});
    expect(response.headers.get("content-length")).toBeNull();
    expect(await publishedProblems(39, whole({}))).toEqual([]);
    expect((await publishedProblems(39, whole({ "content-length": "0" })))[0]).toContain(`${asset("linux-x64")} is empty`);
  });

  it("fails a manifest remote PCs would refuse as too large, and one that is not JSON", async () => {
    const padded = JSON.stringify({ ...manifest("39"), padding: "x".repeat(1024 * 1024) });
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: padded, ...archives })))[0]).toContain("is larger than remote PCs accept");
    expect((await publishedProblems(39, github({ [manifestUrl(39)]: "<html>", ...archives })))[0]).toContain("is not JSON");
  });
});

describe("workerProblems", () => {
  it("passes the recorded deploy and tells how to deploy and record any other source", () => {
    const current = workerFingerprint(["worker", "schema"]);
    expect(workerProblems(current, current)).toEqual([]);
    expect(workerFingerprint(["worker", "schema\r\n"])).toBe(workerFingerprint(["worker", "schema\n"]));
    expect(workerProblems(workerFingerprint(["worker", "schema with attachLimit"]), current)[0]).toContain("bun scripts/release-guards.ts --worker-deployed");
    expect(workerProblems(current, undefined)).toHaveLength(1);
  });
});

describe("check", () => {
  function released(edit: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "hwc-release-"));
    made.push(dir);
    const git = (...args: string[]) => run(dir, ...args);
    const write = (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    };
    const metadata = (version: string) => ({
      "package.json": JSON.stringify({ version, dependencies: { a: "1" } }),
      "herdr-plugin.toml": `version = "${version}"\n`,
      "CHANGELOG.md": `## [Unreleased]\n\n## [${version}]\n\n- Fixed.\n`,
      "release-summaries.json": JSON.stringify({ [version]: Object.fromEntries(["en", "ko", "ja", "zh"].map((language) => [language, { fixed: ["Fixed."] }])) }),
    });
    const worker = { "telemetry/worker.ts": "worker", "shared/telemetry.ts": "schema" };
    write({ ...metadata("1.0.0"), ...worker, "shared/machines.ts": 'export const REMOTE_BUNDLE_VERSION = "1";\n', "server/index.ts": "a", "src/App.tsx": "a",
      [DEPLOYED_FILE]: JSON.stringify({ sha256: workerFingerprint(WORKER_SOURCES.map((path) => worker[path as keyof typeof worker])) }) });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "1.0.0");
    git("tag", "v1.0.0");
    git("tag", "remote-v1");
    write(edit);
    git("add", "-A");
    git("commit", "-qm", "next");
    return dir;
  }
  const releasePr = (dir: string) => {
    const files = { "package.json": JSON.stringify({ version: "1.1.0", dependencies: { a: "1" } }), "herdr-plugin.toml": 'version = "1.1.0"\n' };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n\n## [1.1.0]\n\n- New.\n\n## [1.0.0]\n\n- Fixed.\n");
    const summaries = JSON.parse(readFileSync(join(dir, "release-summaries.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "release-summaries.json"), JSON.stringify({ ...summaries, "1.1.0": summaries["1.0.0"] }));
    run(dir, "commit", "-qam", "release");
  };

  it("leaves any tree whose version is already released alone, whatever it changed", () => {
    expect(check(released({ "server/index.ts": "b", "telemetry/worker.ts": "new" }), false)).toEqual({ version: null, problems: [] });
  });

  it("passes a release PR that changed only the client", () => {
    const dir = released({ "src/App.tsx": "b" });
    releasePr(dir);
    expect(check(dir, false)).toEqual({ version: "1.1.0", problems: [] });
  });

  it("fails a release PR that changed the server or the dependencies but kept the bundle number", () => {
    for (const edit of [{ "server/index.ts": "b" }, { "bun.lock": "new" }]) {
      const dir = released(edit);
      releasePr(dir);
      const { problems } = check(dir, false);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(Object.keys(edit)[0]!);
    }
    const dir = released({ "server/index.ts": "b", "package.json": JSON.stringify({ version: "1.0.0", dependencies: { a: "2" } }) });
    releasePr(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.1.0", dependencies: { a: "2" } }));
    run(dir, "commit", "-qam", "deps");
    expect(check(dir, false).problems[0]).toContain("package.json dependencies");
  });

  it("passes the raised bundle in the PR and fails the Release run until it is published", () => {
    const dir = released({ "server/index.ts": "b", "shared/machines.ts": 'export const REMOTE_BUNDLE_VERSION = "2";\n' });
    releasePr(dir);
    expect(check(dir, false).problems).toEqual([]);
    expect(check(dir, true).problems[0]).toContain("remote-v2 is not published");
    run(dir, "tag", "remote-v2");
    expect(check(dir, true).problems).toEqual([]);
  });

  it("fails the Release run while the tagged bundle is not downloadable, and asks only about a tagged one", async () => {
    const dir = released({ "server/index.ts": "b", "shared/machines.ts": 'export const REMOTE_BUNDLE_VERSION = "2";\n' });
    releasePr(dir);
    const asked: string[] = [];
    const unpublished: Get = async (url) => { asked.push(url); return new Response("Not Found", { status: 404 }); };
    const untagged = await releaseCheck(dir, unpublished);
    expect(untagged.problems).toHaveLength(1);
    expect(untagged.problems[0]).toContain("Push the tag remote-v2");
    expect(asked).toEqual([]);
    run(dir, "tag", "remote-v2");
    const tagged = await releaseCheck(dir, unpublished);
    expect(tagged.version).toBe("1.1.0");
    expect(tagged.problems).toEqual([expect.stringContaining("remote-v2 is tagged but not published")]);
    expect(asked).toEqual([manifestUrl(2)]);
    const archive = (platform: string) => `https://github.com/devswha/ovis/releases/download/remote-v2/herdr-web-ui-${platform}.tgz`;
    const published: Get = async (url) => url === manifestUrl(2)
      ? Response.json({ version: "2", assets: Object.fromEntries(BUNDLE_PLATFORMS.map((platform) => [platform, { url: archive(platform), sha256: "b".repeat(64) }])) })
      : BUNDLE_PLATFORMS.some((platform) => url === archive(platform)) ? new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1000" } }) : new Response("Not Found", { status: 404 });
    expect(await releaseCheck(dir, published)).toEqual({ version: "1.1.0", problems: [] });
  });

  it("passes a change merged after the release PR, which the Release run checks instead", () => {
    const dir = released({ "server/index.ts": "b", "shared/machines.ts": 'export const REMOTE_BUNDLE_VERSION = "2";\n' });
    releasePr(dir);
    expect(check(dir, false, "HEAD^1").version).toBe("1.1.0");
    run(dir, "tag", "remote-v2");
    writeFileSync(join(dir, "server/other.ts"), "c");
    run(dir, "add", "-A");
    run(dir, "commit", "-qm", "feature");
    expect(check(dir, false, "HEAD^1")).toEqual({ version: null, problems: [] });
    expect(check(dir, false, "0000000000000000000000000000000000000000").problems[0]).toContain("server/other.ts");
    expect(check(dir, true).problems[0]).toContain("from 2 to 3");
  });

  it("reads a bun pin for every step that installs the bundles' Bun, so the guard sees a change of it", () => {
    const workflow = readFileSync(join(import.meta.dir, "..", BUNDLE_WORKFLOW), "utf8");
    const steps = Object.values(Bun.YAML.parse(workflow).jobs as Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>)
      .flatMap((job) => job.steps ?? []).filter((step) => /^(oven-sh\/setup-bun@|\.\/\.github\/actions\/setup-ci$)/.test(step.uses ?? ""));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => step.with?.["bun-version"] === undefined).map((step) => step.uses)).toEqual([]);
    expect(bunPins(workflow).split(" ")).toHaveLength(steps.length);
  });

  it("fails a release that moved the bun pin the Linux bundles carry", () => {
    const pin = (version: string) => `steps:\n  - uses: oven-sh/setup-bun@v2\n    with:\n      bun-version: ${version}\n`;
    const dir = released({ [BUNDLE_WORKFLOW]: pin("1.4.2") });
    run(dir, "tag", "-f", "remote-v1");
    writeFileSync(join(dir, BUNDLE_WORKFLOW), pin("1.5.0"));
    run(dir, "commit", "-qam", "bun");
    releasePr(dir);
    expect(check(dir, false).problems[0]).toContain(`${BUNDLE_WORKFLOW} bun-version`);
  });

  it("fails a release whose Worker changed without a recorded deploy, and one without patch notes", () => {
    const dir = released({ "telemetry/worker.ts": "worker with a new field" });
    releasePr(dir);
    const { problems } = check(dir, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("telemetry/worker.ts or shared/telemetry.ts changed");
    writeFileSync(join(dir, "release-summaries.json"), "{}");
    expect(check(dir, false).problems[0]).toContain("release-summaries.json must tell this version in: en, ko, ja, zh.");
  });
});
