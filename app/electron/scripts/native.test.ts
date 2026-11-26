import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../../../package.json";
import { stageServerArtifact } from "../../../scripts/server-artifact.ts";
import { acpKeeperBin } from "../../../server/acp/keeper-bin.ts";
import { installedHelpers, releaseHelpers } from "./native.ts";
import { resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ovis-desktop-keeper-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it.skipIf(process.platform === "win32")("stages an independently verified keeper where the app's server resolves it, even without a host", async () => {
  const bin = join(root, "bin");
  const dir = join(root, "stage", "server");
  const dist = join(root, "dist");
  mkdirSync(bin);
  mkdirSync(dist);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dist, "index.html"), "<title>Ovis</title>");
  const binary = join(bin, "ovis-acp-keeper");
  const bytes = '#!/bin/sh\necho "Usage: ovis-acp-keeper ROOT" >&2\nexit 2\n';
  writeFileSync(binary, bytes);
  expect(installedHelpers(bin).acpKeeper).toBeUndefined();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  writeFileSync(`${binary}.json`, JSON.stringify({ sha256, version }));
  await stageServerArtifact({ ...installedHelpers(bin), platform: "linux-x64", dir, dist, build: async (_, out) => writeFileSync(out, "server") });
  // The compiled server uses its embedded version; the source resolver reads the same version here.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  const installed = join(dir, "bin", "ovis-acp-keeper");
  expect(acpKeeperBin({}, { installed, build: join(root, "no-cargo-build") })).toBe(installed);
});

it.skipIf(process.platform === "win32")("does not pass the packaging environment to a helper identity probe", () => {
  const path = join(root, "probe");
  writeFileSync(path, '#!/bin/sh\n[ -z "$OVIS_TEST_BUILD_CANARY" ] || exit 1\necho "Usage: ovis-acp-keeper ROOT" >&2\nexit 2\n', { mode: 0o755 });
  const module = resolve(import.meta.dir, "../../../scripts/pty-sidecar.ts");
  const child = Bun.spawnSync([process.execPath, "-e", 'const { runsHere, ACP_KEEPER } = await import(process.argv[1]); process.exit(runsHere(process.argv[2], ACP_KEEPER) ? 0 : 1)', module, path], { env: { PATH: process.env["PATH"], OVIS_TEST_BUILD_CANARY: "inert-fixture" } });
  expect(child.exitCode).toBe(0);
});

it("refuses an unsigned release even when a locally vouched keeper exists", async () => {
  const release = mkdtempSync(join(root, "unsigned-"));
  writeFileSync(join(release, "ovis-acp-keeper.json"), JSON.stringify({ version }));
  await expect(releaseHelpers(root, "linux-x64", { version, at: new URL("file://" + release).href })).rejects.toThrow("ovis-server.json");
});

it("does not bless different keeper bytes copied after selection", async () => {
  const base = mkdtempSync(join(root, "changed-"));
  mkdirSync(join(base, "bin")); mkdirSync(join(base,"dist")); writeFileSync(join(base,"dist/index.html"), "client");
  writeFileSync(join(base,"package.json"), JSON.stringify({version}));
  const file = join(base, "bin/ovis-acp-keeper");
  writeFileSync(file, "selected"); writeFileSync(file + ".json", JSON.stringify({version, sha256: new Bun.CryptoHasher("sha256").update("selected").digest("hex")}));
  const helpers = installedHelpers(join(base,"bin"));
  await expect(stageServerArtifact({ ...helpers, dir: join(base,"server"), dist: join(base,"dist"), platform:"linux-x64", build: async (_, out) => { writeFileSync(out,"server"); writeFileSync(file,"changed"); } })).rejects.toThrow("SHA-256");
});
