/**
 * Notarizes and staples the macOS app and dmg. electron-builder signs the app (hardened runtime,
 * build/entitlements.mac*.plist) and the dmg (dmg.sign); its own notarization is off
 * (mac.notarize: false) because it staples with retries a second or two apart, too short for the
 * dropped connections Apple's ticket service has. Two hooks (electron-builder.yml) call this file:
 * afterSign (scripts/notarize-app.mjs) notarizes the app before the dmg and zip are made from it,
 * and artifactBuildCompleted (the default export here) the dmg. Plain JavaScript, so it loads under
 * whichever Node runs electron-builder.
 *
 * It runs when the notary key is set:
 *
 *   APPLE_API_KEY      path to an App Store Connect API key (.p8)
 *   APPLE_API_KEY_ID   its key ID
 *   APPLE_API_ISSUER   its issuer ID
 *
 * Signing takes electron-builder's own: CSC_LINK (a .p12, as a path or base64) with
 * CSC_KEY_PASSWORD, or CSC_NAME for a Developer ID Application identity already in a keychain.
 * Without an identity the build is unsigned. A build without the notary key goes unnotarized,
 * unless OVIS_REQUIRE_NOTARIZATION=1 (a release), which stops it, signed or not; a notary key
 * without a signed dmg stops the build too. Only the API key notarizes: electron-builder's Apple ID
 * or keychain profile credentials stop the build rather than ship it unnotarized.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const NOTARY_ENV = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

/** waits between staple tries: six tries over about five and a half minutes */
export const STAPLE_WAITS = [20_000, 40_000, 60_000, 90_000, 120_000];
/**
 * All the waiting one build may do, app and dmg together: the build, two notarizations and this
 * stay within the Mac build job's 30 minutes (.github/workflows/desktop.yml).
 */
export const WAIT_BUDGET = 8 * 60_000;

/** @typedef {(file: string, args: string[]) => Promise<string>} Run */
/** @typedef {{ waited: number }} Budget */
/** @typedef {{ env?: Record<string, string | undefined>, run?: Run, log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, budget?: Budget }} Options */

/** the waits so far in this build (electron-builder loads the hooks once) @type {Budget} */
const spent = { waited: 0 };

/** @type {Run} */
export function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`), { stdout, code: error.code }));
      else resolve(stdout);
    });
  });
}

/** @param {Options} options */
function defaults(options) {
  return {
    env: options.env ?? process.env,
    exec: options.run ?? run,
    log: options.log ?? ((line) => console.log(`  • ${line}`)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    budget: options.budget ?? spent,
  };
}

/**
 * The notarytool key arguments, or null when no key is set and the build may go unnotarized.
 * @param {Record<string, string | undefined>} env
 * @param {string} file
 */
function notaryKey(env, file) {
  const set = NOTARY_ENV.filter((name) => env[name]?.trim());
  if (set.length === 0) {
    const other = ["APPLE_ID", "APPLE_KEYCHAIN_PROFILE"].filter((name) => env[name]?.trim());
    if (other.length > 0) throw new Error(`${other.join(" and ")} cannot notarize this build; set ${NOTARY_ENV.join(", ")} to notarize ${file}`);
    if (env["OVIS_REQUIRE_NOTARIZATION"] === "1") throw new Error(`OVIS_REQUIRE_NOTARIZATION=1, but ${NOTARY_ENV.join(", ")} are not set: ${file} would ship unnotarized`);
    return null;
  }
  if (set.length < NOTARY_ENV.length) throw new Error(`Notarizing needs all of ${NOTARY_ENV.join(", ")}; missing ${NOTARY_ENV.filter((name) => !set.includes(name)).join(", ")}`);
  return ["--key", env["APPLE_API_KEY"].trim(), "--key-id", env["APPLE_API_KEY_ID"].trim(), "--issuer", env["APPLE_API_ISSUER"].trim()];
}

/**
 * @param {string} upload @param {string} file @param {string[]} key @param {Run} exec
 */
async function submit(upload, file, key, exec) {
  // notarytool may exit non-zero on a rejected submission; its JSON still names it, for the log below
  const answer = await exec("xcrun", ["notarytool", "submit", upload, ...key, "--wait", "--output-format", "json"]).catch((error) => {
    if (typeof error?.stdout === "string" && error.stdout.trim().startsWith("{")) return error.stdout;
    throw error;
  });
  const submitted = JSON.parse(answer);
  if (submitted.status !== "Accepted") {
    const details = submitted.id ? await exec("xcrun", ["notarytool", "log", submitted.id, ...key]).catch((error) => String(error)) : "";
    throw new Error(`Notarization of ${file} ended ${submitted.status ?? "without a status"}: ${submitted.message ?? ""}\n${details}`);
  }
  return submitted.id;
}

/**
 * stapler's error 68 and the URL errors under it: a dropped or timed out connection to Apple's
 * ticket service, worth another try. Any other failure (no ticket, a bad file) is not.
 * @param {unknown} error
 */
export function isNetworkFailure(error) {
  const failure = /** @type {{ code?: unknown, message?: unknown, stdout?: unknown }} */ (error ?? {});
  return failure.code === 68 || /Error 68\b|NSURLErrorDomain Code=-10(?:01|05|09)\b|network connection was lost/i.test(`${failure.message ?? error} ${failure.stdout ?? ""}`);
}

/**
 * Staples Apple's ticket to `file`, then checks it, each tried again while the connection drops:
 * a staple that worked is not repeated, as stapling again can fail where the first did not.
 * @param {string} file @param {ReturnType<typeof defaults>} tools
 */
async function staple(file, tools) {
  for (const action of ["staple", "validate"]) {
    for (let attempt = 0; ; attempt++) {
      try {
        await tools.exec("xcrun", ["stapler", action, file]);
        break;
      } catch (error) {
        const wait = STAPLE_WAITS[attempt];
        if (wait === undefined || tools.budget.waited + wait > WAIT_BUDGET || !isNetworkFailure(error)) throw error;
        tools.budget.waited += wait;
        tools.log(`stapler ${action} ${file} lost the connection to Apple; trying again in ${wait / 1000} s (try ${attempt + 2} of ${STAPLE_WAITS.length + 1})`);
        await tools.sleep(wait);
      }
    }
  }
}

/**
 * @param {string} app
 * @param {Options} [options]
 * @returns {Promise<"notarized" | "skipped">}
 */
export async function notarizeApp(app, options = {}) {
  const tools = defaults(options);
  const key = notaryKey(tools.env, app);
  if (!key) {
    tools.log(`no notary key (${NOTARY_ENV.join(", ")}): ${app} is not notarized`);
    return "skipped";
  }
  tools.log(`notarizing ${app}`);
  const dir = mkdtempSync(join(tmpdir(), "ovis-notarize-"));
  let id;
  try {
    // notarytool takes an app as a zip; the app itself gets the ticket
    const zip = join(dir, `${basename(app, ".app")}.zip`);
    await tools.exec("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
    id = await submit(zip, app, key, tools.exec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await staple(app, tools);
  tools.log(`notarized and stapled ${app} (${id})`);
  return "notarized";
}

/**
 * @param {string} dmg
 * @param {Options} [options]
 * @returns {Promise<"notarized" | "skipped">}
 */
export async function notarizeDmg(dmg, options = {}) {
  const tools = defaults(options);
  const key = notaryKey(tools.env, dmg);
  if (!key) {
    tools.log(`no notary key (${NOTARY_ENV.join(", ")}): ${dmg} is not notarized`);
    return "skipped";
  }
  try {
    await tools.exec("codesign", ["--verify", "--strict", dmg]);
  } catch (error) {
    throw new Error(`${dmg} is not signed, so it cannot be notarized: set CSC_LINK or CSC_NAME to a Developer ID Application identity (${error instanceof Error ? error.message : error})`);
  }
  tools.log(`notarizing ${dmg}`);
  const id = await submit(dmg, dmg, key, tools.exec);
  await staple(dmg, tools);
  // what Gatekeeper asks of a downloaded dmg before it mounts it
  await tools.exec("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
  tools.log(`notarized and stapled ${dmg} (${id})`);
  return "notarized";
}

/** @param {{ file: string }} context */
export default async function artifactBuildCompleted(context) {
  if (context.file.endsWith(".dmg")) await notarizeDmg(context.file);
}
