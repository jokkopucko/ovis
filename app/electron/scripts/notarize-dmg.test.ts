import { describe, expect, it } from "bun:test";
import { notarizeDmg } from "./notarize-dmg.mjs";

const key = { APPLE_API_KEY: "/keys/AuthKey.p8", APPLE_API_KEY_ID: "KEYID", APPLE_API_ISSUER: "issuer" };

function recorder(answers: Record<string, string | Error> = {}) {
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    const call = [file, ...args];
    calls.push(call);
    const answer = Object.entries(answers).find(([prefix]) => call.join(" ").startsWith(prefix))?.[1] ?? "";
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, run };
}

const quiet = () => {};

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

  it("stops on credentials that notarize only the app", async () => {
    const { run } = recorder();
    await expect(notarizeDmg("dist/Ovis.dmg", { env: { APPLE_KEYCHAIN_PROFILE: "ovis" }, run, log: quiet })).rejects.toThrow(/APPLE_KEYCHAIN_PROFILE notarize only the app/);
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

  it("stops with Apple's log when the submission is not accepted, and staples nothing", async () => {
    const { calls, run } = recorder({
      "xcrun notarytool submit": JSON.stringify({ id: "sub-2", status: "Invalid", message: "Processing complete" }),
      "xcrun notarytool log": "The binary is not signed with a valid Developer ID certificate.",
    });
    await expect(notarizeDmg("dist/Ovis.dmg", { env: key, run, log: quiet })).rejects.toThrow(/ended Invalid[\s\S]*valid Developer ID/);
    expect(calls.some((call) => call.includes("stapler"))).toBe(false);
  });
});
