import { expect, test } from "bun:test";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST_ARCHIVE, generateKeyPair, RELEASE_PUBLIC_KEY, releaseFile, PTY_ASSETS, ptyFile, SERVER_PLATFORMS, signManifest, verifyRelease, writeManifest } from "./server-manifest.ts";
import { parseWorkflow, root } from "./shell-workflow-rules.ts";

/**
 * The release's sign and publish steps, run as the jobs run them: their own scripts from release.yml, in folders of
 * stand-in files. Both check against RELEASE_PUBLIC_KEY, whose private half no test has, so a test that needs a release
 * to pass runs a copy of the step whose verify and sign lines name its own key; the step as written is what refuses
 * every other key.
 */
const release = parseWorkflow(join(root, ".github/workflows/release.yml"));
const job = (name: string) => release.jobs[name]!;
const step = (jobName: string, name: string) => job(jobName).steps!.find((candidate) => candidate.name === name)!;

const workflowFiles = readdirSync(join(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name));
const allJobs = workflowFiles.flatMap((name) => Object.entries(parseWorkflow(join(root, ".github/workflows", name)).jobs).map(([id, candidate]) => ({ where: `${name}:${id}`, job: candidate })));
const environmentOf = (candidate: unknown): unknown => {
  const environment = (candidate as { environment?: unknown }).environment;
  return typeof environment === "object" && environment !== null ? (environment as { name?: unknown }).name : environment;
};

test("only the sign job names the environment release-signing or reads its key", () => {
  expect(allJobs.filter(({ job: candidate }) => environmentOf(candidate) === "release-signing").map(({ where }) => where)).toEqual(["release.yml:server-binary-sign"]);
  // a job that deploys reads its own environment, never the key's
  expect(allJobs.filter(({ job: candidate }) => JSON.stringify(candidate).includes("OVIS_SERVER_SIGNING_KEY")).map(({ where }) => where)).toEqual(["release.yml:server-binary-sign"]);
});

test("a sign job that failed or was skipped leaves publish, and so the tag and the release, unmade", () => {
  // GitHub runs a job only when every job it needs succeeded, unless its if calls a status function; publish and the
  // attest job between them call none
  const STATUS = /\b(always|failure|cancelled|success)\s*\(/i;
  for (const name of ["server-binary-attest", "publish"]) expect(STATUS.test(String(job(name).if ?? ""))).toBe(false);
  expect([job("publish").needs].flat()).toContain("server-binary-sign");
  expect([job("server-binary-attest").needs].flat()).toContain("server-binary-sign");
});

test("the signing key reaches one step, on GitHub's runner, with no package installed beside it", () => {
  const runs = job("server-binary-sign").steps!.map((candidate) => `${candidate.uses ?? ""} ${candidate.run ?? ""}`).join("\n");
  expect(runs).not.toContain("bun install");
  expect(runs).not.toContain("setup-ci");
});

const SERVER_FILES = [...SERVER_PLATFORMS.map(releaseFile), DIST_ARCHIVE, "ovis-server.json", "ovis-server.json.sig", "ovis-server.SHA256SUMS"];
const sources = { server: "a".repeat(40), shared: "b".repeat(40) };

function signedFolder(temp: string): { publicKey: string; privateKeyPem: string } {
  const dir = join(temp, "server-binary");
  mkdirSync(dir, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
  writeFileSync(join(dir, DIST_ARCHIVE), "the built client\n");
  writeManifest(dir, { version: "1.2.3", sources });
  const { privateKeyPem, publicKey } = generateKeyPair();
  signManifest(dir, privateKeyPem);
  return { publicKey, privateKeyPem };
}

function trusting(script: string, publicKey: string): string {
  const copy = script.replace(/(bun scripts\/build-server\.ts (?:sign|verify) "\$RUNNER_TEMP\/server-binary")/g, `$1 --public-key ${publicKey}`);
  expect(copy).not.toBe(script);
  return copy;
}

function runAttach(prepare: (dir: string, privateKeyPem: string) => void, trust = true, builtHost?: string): { code: number; attached: string[]; err: string } {
  const temp = mkdtempSync(join(tmpdir(), "ovis-attach-step-"));
  try {
    const { publicKey, privateKeyPem } = signedFolder(temp);
    prepare(join(temp, "server-binary"), privateKeyPem);
    mkdirSync(join(temp, "pty-sidecar"));
    writeFileSync(join(temp, "pty-sidecar", "ovis-pty-sidecar.json"), "{}");
    for (const build of PTY_ASSETS) if (existsSync(join(temp, "server-binary", ptyFile(build)))) copyFileSync(join(temp, "server-binary", ptyFile(build)), join(temp, "pty-sidecar", ptyFile(build)));
    if (builtHost !== undefined) writeFileSync(join(temp, "pty-sidecar", ptyFile("linux-x64")), builtHost);
    mkdirSync(join(temp, "stub"));
    writeFileSync(join(temp, "stub", "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(temp, "gh-args")}"\n`);
    chmodSync(join(temp, "stub", "gh"), 0o755);
    const lines = step("publish", "Publish the validated commit").run!.split("\n");
    const from = lines.findIndex((line) => line.trim().startsWith("server_files=("));
    const to = lines.findIndex((line) => line.trim().startsWith("gh release create"));
    expect(from).toBeGreaterThan(-1);
    const script = lines.slice(from, to + 1).join("\n");
    const result = Bun.spawnSync(["bash", "-e", "-c", trust ? trusting(script, publicKey) : script], {
      cwd: root, env: { ...process.env, PATH: `${join(temp, "stub")}:${process.env["PATH"]}`, RUNNER_TEMP: temp, RELEASE_VERSION: "1.2.3", GITHUB_SHA: "c".repeat(40) }, stdout: "pipe", stderr: "pipe",
    });
    const args = existsSync(join(temp, "gh-args")) ? readFileSync(join(temp, "gh-args"), "utf8").trim().split("\n") : [];
    return { code: result.exitCode, err: result.stderr.toString(), attached: args.filter((arg) => arg.includes("/server-binary/")).map((arg) => arg.split("/server-binary/")[1]!) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("publish attaches each server file and the client archive by name, only once they verify", () => {
  const { code, attached } = runAttach(() => {});
  expect(code).toBe(0);
  expect(attached.sort()).toEqual([...SERVER_FILES].sort());
});

test("publish refuses a release signed by any key but the committed one, and attaches nothing", () => {
  const { code, err, attached } = runAttach(() => {}, false);
  expect(code).not.toBe(0);
  expect(err).toContain(RELEASE_PUBLIC_KEY);
  expect(attached).toEqual([]);
});

test("publish attaches nothing else that lands in the server folder, such as a key", () => {
  expect(runAttach((dir) => writeFileSync(join(dir, "ovis-server-signing-key.pem"), "secret")).code).not.toBe(0);
  expect(runAttach((dir) => writeFileSync(join(dir, "ovis-server-extra"), "x")).attached).toEqual([]);
});

test("publish attaches no PTY host but the one ovis-server.json signed", () => {
  const result = runAttach(() => {}, true, "another host\n");
  expect(result.code).not.toBe(0);
  expect(result.attached).toEqual([]);
});


test("publish refuses server files signed for another version than the one it releases", () => {
  // signed again by the same key: the signature holds, only the version check can refuse it
  const { code, err, attached } = runAttach((dir, privateKeyPem) => {
    writeManifest(dir, { version: "1.2.2", sources });
    signManifest(dir, privateKeyPem);
  });
  expect(code).not.toBe(0);
  expect(err).toContain("is for version 1.2.2, not the expected 1.2.3");
  expect(attached).toEqual([]);
});

function runSignStep(key: string, trust?: string): { code: number; err: string; dir: string } {
  const temp = mkdtempSync(join(tmpdir(), "ovis-sign-step-"));
  const dir = join(temp, "server-binary");
  mkdirSync(dir);
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
  writeFileSync(join(dir, DIST_ARCHIVE), "the built client\n");
  writeManifest(dir, { version: "1.2.3", sources });
  const script = step("server-binary-sign", "Sign the manifest").run!;
  const result = Bun.spawnSync(["bash", "-e", "-c", trust ? trusting(script, trust) : script], {
    cwd: root, env: { ...process.env, RUNNER_TEMP: temp, OVIS_SERVER_SIGNING_KEY: key, RELEASE_VERSION: "1.2.3" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, err: result.stderr.toString(), dir };
}

test("without the secret the sign step fails and names it, and leaves nothing signed", () => {
  const { code, err, dir } = runSignStep("");
  try {
    expect(code).toBe(1);
    expect(err).toContain("::error title=Server binary not signed::");
    expect(err).toContain("OVIS_SERVER_SIGNING_KEY");
    expect(existsSync(join(dir, "ovis-server.json.sig"))).toBe(false);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("a key in the secret that is not the committed one fails the sign step, and signs nothing", () => {
  const { code, err, dir } = runSignStep(generateKeyPair().privateKeyPem);
  try {
    expect(code).toBe(1);
    expect(err).toContain(RELEASE_PUBLIC_KEY);
    expect(existsSync(join(dir, "ovis-server.json.sig"))).toBe(false);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

test("with the key it expects, the sign step writes a signature that key verifies, and writes no key", () => {
  const { privateKeyPem, publicKey } = generateKeyPair();
  const { code, dir } = runSignStep(privateKeyPem, publicKey);
  try {
    expect(code).toBe(0);
    expect(verifyRelease(dir, publicKey, { version: "1.2.3" })).toEqual({ ok: true, problems: [] });
    // no file the step leaves behind, in the uploaded folder or beside it, holds any line of the private key
    const keyLines = privateKeyPem.split("\n").filter((line) => line.length > 20 && !line.startsWith("-----"));
    for (const file of filesUnder(join(dir, ".."))) for (const line of keyLines) expect(readFileSync(file, "utf8")).not.toContain(line);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
