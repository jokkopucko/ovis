import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { notarizeApp, notarizeDmg } from "./notarize-dmg.mjs";

const key = { APPLE_API_KEY: "/keys/AuthKey.p8", APPLE_API_KEY_ID: "KEYID", APPLE_API_ISSUER: "issuer" };

type Answer = string | Error;

function recorder(answers: Record<string, Answer | Answer[]> = {}) {
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    const call = [file, ...args];
    calls.push(call);
    const entry = Object.entries(answers).find(([prefix]) => call.join(" ").startsWith(prefix))?.[1] ?? "";
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, run };
}

const quiet = () => {};
const accepted = JSON.stringify({ id: "sub-1", status: "Accepted" });
// what stapler says when Apple's ticket service drops the connection (release run 42333510867)
const connectionLost = () =>
  Object.assign(new Error("xcrun stapler staple dist/Ovis.dmg failed: The staple and validate action failed! Error 68."), {
    code: 68,
    stdout: 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
  });

function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms), budget: { waited: 0 } };
}

describe("notarizeDmg", () => {
  it("submits a signed dmg, then staples and checks it", async () => {
    const { calls, run } = recorder({ "xcrun notarytool submit": JSON.stringify({ id: "sub-1", status: "Accepted" }) });
    expect(await notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet })).toBe("notarized");
    expect(calls).toEqual([
      ["codesign", "--verify", "--strict", "dist/Ovis.dmg"],
      ["xcrun", "notarytool", "submit", "dist/Ovis.dmg", "--key", "/keys/AuthKey.p8", "--key-id", "KEYID", "--issuer", "issuer", "--wait", "--output-format", "json"],
      ["xcrun", "stapler", "staple", "dist/Ovis.dmg"],
      ["xcrun", "stapler", "validate", "dist/Ovis.dmg"],
      ["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "dist/Ovis.dmg"],
    ]);
  });

  it("fetches Apple's log when notarytool exits non-zero on a rejected submission", async () => {
    const { calls, run } = recorder({
      "xcrun notarytool submit": Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ id: "sub-3", status: "Invalid" }) }),
      "xcrun notarytool log": "The signature of the binary is invalid.",
    });
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet })).rejects.toThrow(/ended Invalid[\s\S]*signature of the binary is invalid/);
    expect(calls.some((call) => call[1] === "notarytool" && call[2] === "log" && call[3] === "sub-3")).toBe(true);
  });

  it("leaves the dmg alone without a notary key", async () => {
    const { calls, run } = recorder();
    expect(await notarizeDmg("dist/Ovis.dmg", { env: {}, run, log: quiet })).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("stops a release build that has no notary key", async () => {
    const { calls, run } = recorder();
    await expect(notarizeDmg("dist/Ovis.dmg", { env: { OVIS_REQUIRE_NOTARIZATION: "1" }, run, log: quiet })).rejects.toThrow(/would ship unnotarized/);
    expect(calls).toEqual([]);
  });

  it("stops on credentials it does not notarize with", async () => {
    const { run } = recorder();
    await expect(notarizeDmg("dist/Ovis.dmg", { env: { APPLE_KEYCHAIN_PROFILE: "ovis" }, run, log: quiet })).rejects.toThrow(/APPLE_KEYCHAIN_PROFILE cannot notarize/);
  });

  it("stops on a partial notary key", async () => {
    const { run } = recorder();
    await expect(notarizeDmg("dist/Ovis.dmg", { env: { APPLE_API_KEY: "/keys/AuthKey.p8" }, run, log: quiet })).rejects.toThrow(/missing APPLE_API_KEY_ID, APPLE_API_ISSUER/);
  });

  it("stops on an unsigned dmg", async () => {
    const { calls, run } = recorder({ codesign: new Error("code object is not signed at all") });
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet })).rejects.toThrow(/not signed/);
    expect(calls).toHaveLength(1);
  });

  it("staples again after a wait when Apple's ticket service drops the connection", async () => {
    const { calls, run } = recorder({ "xcrun notarytool submit": accepted, "xcrun stapler staple": [connectionLost(), ""] });
    const { waits, sleep, budget } = sleeper();
    expect(await notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet, sleep, budget })).toBe("notarized");
    expect(calls.filter((call) => call[2] === "staple")).toHaveLength(2);
    expect(waits).toEqual([20_000]);
  });

  it("gives up after six tries when the connection keeps dropping", async () => {
    const { calls, run } = recorder({ "xcrun notarytool submit": accepted, "xcrun stapler staple": connectionLost() });
    const { waits, sleep, budget } = sleeper();
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet, sleep, budget })).rejects.toThrow(/Error 68/);
    expect(calls.filter((call) => call[2] === "staple")).toHaveLength(6);
    expect(waits).toEqual([20_000, 40_000, 60_000, 90_000, 120_000]);
  });

  it("stops trying once the build has waited its whole budget", async () => {
    const { calls, run } = recorder({ "xcrun notarytool submit": accepted, "xcrun stapler staple": connectionLost() });
    const { waits, sleep, budget } = sleeper();
    budget.waited = 6 * 60_000;
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet, sleep, budget })).rejects.toThrow(/Error 68/);
    // 6 min spent: 20 + 40 + 60 s fill the 8 min budget, so the 90 s wait is never taken
    expect(waits).toEqual([20_000, 40_000, 60_000]);
    expect(calls.filter((call) => call[2] === "staple")).toHaveLength(4);
  });

  it("does not staple again when stapling fails for another reason", async () => {
    const { calls, run } = recorder({ "xcrun notarytool submit": accepted, "xcrun stapler staple": Object.assign(new Error("Record not found"), { code: 65 }) });
    const { waits, sleep, budget } = sleeper();
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet, sleep, budget })).rejects.toThrow(/Record not found/);
    expect(calls.filter((call) => call[2] === "staple")).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("stops with Apple's log when the submission is not accepted, and staples nothing", async () => {
    const { calls, run } = recorder({
      "xcrun notarytool submit": JSON.stringify({ id: "sub-2", status: "Invalid", message: "Processing complete" }),
      "xcrun notarytool log": "The binary is not signed with a valid Developer ID certificate.",
    });
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet })).rejects.toThrow(/ended Invalid[\s\S]*valid Developer ID/);
    expect(calls.some((call) => call.includes("stapler"))).toBe(false);
  });
});

describe("notarizeApp", () => {
  it("submits the app zipped, staples it, and checks it again after a dropped connection without stapling again", async () => {
    const { calls, run } = recorder({ "xcrun notarytool submit": accepted, "xcrun stapler validate": [connectionLost(), ""] });
    const { waits, sleep, budget } = sleeper();
    expect(await notarizeApp("dist/mac/Ovis.app", { env: key, run, log: quiet, sleep, budget })).toBe("notarized");
    const zip = calls[0]![6]!;
    expect(basename(zip)).toBe("Ovis.zip");
    expect(calls).toEqual([
      ["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", "dist/mac/Ovis.app", zip],
      ["xcrun", "notarytool", "submit", zip, "--key", "/keys/AuthKey.p8", "--key-id", "KEYID", "--issuer", "issuer", "--wait", "--output-format", "json"],
      ["xcrun", "stapler", "staple", "dist/mac/Ovis.app"],
      ["xcrun", "stapler", "validate", "dist/mac/Ovis.app"],
      ["xcrun", "stapler", "validate", "dist/mac/Ovis.app"],
    ]);
    expect(waits).toEqual([20_000]);
  });

  it("stops a release build that has no notary key", async () => {
    const { calls, run } = recorder();
    await expect(notarizeApp("dist/mac/Ovis.app", { env: { OVIS_REQUIRE_NOTARIZATION: "1" }, run, log: quiet })).rejects.toThrow(/would ship unnotarized/);
    expect(calls).toEqual([]);
  });
});

describe("electron-builder.yml", () => {
  it("leaves the app's notarization to the afterSign hook", () => {
    const config = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../electron-builder.yml"), "utf8")) as { afterSign?: string; artifactBuildCompleted?: string; mac?: { notarize?: boolean } };
    expect(config.afterSign).toBe("./scripts/notarize-app.mjs");
    expect(config.artifactBuildCompleted).toBe("./scripts/notarize-dmg.mjs");
    expect(config.mac?.notarize).toBe(false);
  });
});
