/**
 * electron-builder's artifactBuildCompleted hook (electron-builder.yml): notarizes and staples the
 * macOS dmg, so it opens without a Gatekeeper warning even offline. electron-builder signs the app
 * (hardened runtime, build/entitlements.mac*.plist), notarizes and staples the app, and signs the
 * dmg (dmg.sign); only the dmg's notarization is left to this hook. Plain JavaScript, so it loads
 * under whichever Node runs electron-builder.
 *
 * It runs when the dmg is signed and the notary key is set, the same variables electron-builder
 * notarizes the app with:
 *
 *   APPLE_API_KEY      path to an App Store Connect API key (.p8)
 *   APPLE_API_KEY_ID   its key ID
 *   APPLE_API_ISSUER   its issuer ID
 *
 * Signing takes electron-builder's own: CSC_LINK (a .p12, as a path or base64) with
 * CSC_KEY_PASSWORD, or CSC_NAME for a Developer ID Application identity already in a keychain.
 * Without an identity the build is unsigned and this hook does nothing; a notary key without a
 * signed dmg stops the build, and so does a signed dmg without one when OVIS_REQUIRE_NOTARIZATION=1
 * (a release). Only the API key notarizes the dmg: electron-builder's Apple ID or keychain profile
 * credentials alone stop the build rather than ship an app that is notarized in a dmg that is not.
 */
import { execFile } from "node:child_process";

export const NOTARY_ENV = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

/** @typedef {(file: string, args: string[]) => Promise<string>} Run */

/** @type {Run} */
export function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`), { stdout }));
      else resolve(stdout);
    });
  });
}

/**
 * @param {string} dmg
 * @param {{ env?: Record<string, string | undefined>, run?: Run, log?: (line: string) => void }} [options]
 * @returns {Promise<"notarized" | "skipped">}
 */
export async function notarizeDmg(dmg, options = {}) {
  const env = options.env ?? process.env;
  const exec = options.run ?? run;
  const log = options.log ?? ((line) => console.log(`  • ${line}`));
  const set = NOTARY_ENV.filter((name) => env[name]?.trim());
  if (set.length === 0) {
    const other = ["APPLE_ID", "APPLE_KEYCHAIN_PROFILE"].filter((name) => env[name]?.trim());
    if (other.length > 0) throw new Error(`${other.join(" and ")} notarize only the app; set ${NOTARY_ENV.join(", ")} to notarize ${dmg} too`);
    if (env["OVIS_REQUIRE_NOTARIZATION"] === "1") throw new Error(`OVIS_REQUIRE_NOTARIZATION=1, but ${NOTARY_ENV.join(", ")} are not set: ${dmg} would ship unnotarized`);
    log(`no notary key (${NOTARY_ENV.join(", ")}): ${dmg} is not notarized`);
    return "skipped";
  }
  if (set.length < NOTARY_ENV.length) throw new Error(`Notarizing needs all of ${NOTARY_ENV.join(", ")}; missing ${NOTARY_ENV.filter((name) => !set.includes(name)).join(", ")}`);
  try {
    await exec("codesign", ["--verify", "--strict", dmg]);
  } catch (error) {
    throw new Error(`${dmg} is not signed, so it cannot be notarized: set CSC_LINK or CSC_NAME to a Developer ID Application identity (${error instanceof Error ? error.message : error})`);
  }
  log(`notarizing ${dmg}`);
  const key = ["--key", env["APPLE_API_KEY"].trim(), "--key-id", env["APPLE_API_KEY_ID"].trim(), "--issuer", env["APPLE_API_ISSUER"].trim()];
  // notarytool may exit non-zero on a rejected submission; its JSON still names it, for the log below
  const answer = await exec("xcrun", ["notarytool", "submit", dmg, ...key, "--wait", "--output-format", "json"]).catch((error) => {
    if (typeof error?.stdout === "string" && error.stdout.trim().startsWith("{")) return error.stdout;
    throw error;
  });
  const submitted = JSON.parse(answer);
  if (submitted.status !== "Accepted") {
    const details = submitted.id ? await exec("xcrun", ["notarytool", "log", submitted.id, ...key]).catch((error) => String(error)) : "";
    throw new Error(`Notarization of ${dmg} ended ${submitted.status ?? "without a status"}: ${submitted.message ?? ""}\n${details}`);
  }
  await exec("xcrun", ["stapler", "staple", dmg]);
  await exec("xcrun", ["stapler", "validate", dmg]);
  // what Gatekeeper asks of a downloaded dmg before it mounts it
  await exec("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
  log(`notarized and stapled ${dmg} (${submitted.id})`);
  return "notarized";
}

/** @param {{ file: string }} context */
export default async function artifactBuildCompleted(context) {
  if (context.file.endsWith(".dmg")) await notarizeDmg(context.file);
}
