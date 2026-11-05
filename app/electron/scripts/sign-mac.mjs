/**
 * electron-builder's mac.sign (electron-builder.yml): signs the app as electron-builder does, after
 * signing the bundled Rust PTY host first. The server runs that host only while its record
 * (`ovis-pty-sidecar.json`, written by scripts/pty-sidecar.ts install) holds the binary's SHA-256
 * (server/pty/host.ts), and signing rewrites the binary: so the record takes the signed bytes' hash
 * before the app's seal covers both, and the host is left out of the signing that follows.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./notarize-dmg.mjs";

export const HOST = "Contents/Resources/ovis/server/bin/ovis-pty-sidecar";

/**
 * @param {string} host
 * @param {{ identity: string, keychain?: string, entitlements?: string }} signing
 * @param {import("./notarize-dmg.mjs").Run} exec
 */
export async function signHost(host, signing, exec = run) {
  const args = ["--sign", signing.identity, "--force", "--timestamp", "--options", "runtime"];
  if (signing.entitlements) args.push("--entitlements", signing.entitlements);
  if (signing.keychain) args.push("--keychain", signing.keychain);
  await exec("codesign", [...args, host]);
  const recordPath = `${host}.json`;
  if (!existsSync(recordPath)) return;
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.sha256 = createHash("sha256").update(readFileSync(host)).digest("hex");
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
}

/** @param {{ app: string, identity: string, keychain?: string, ignore: (file: string) => boolean, optionsForFile: (file: string) => { entitlements?: string } }} opts */
export default async function sign(opts) {
  const { sign: signApp } = await import("app-builder-lib/out/codeSign/macCodeSign.js");
  const host = join(opts.app, HOST);
  if (!existsSync(host)) return signApp(opts);
  await signHost(host, { identity: opts.identity, keychain: opts.keychain, entitlements: opts.optionsForFile(host).entitlements });
  return signApp({ ...opts, ignore: (file) => file === host || opts.ignore(file) });
}
