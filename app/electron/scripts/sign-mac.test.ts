import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { signHost } from "./sign-mac.mjs";

// the server's own check, loaded at run time: this folder's typecheck does not cover server/
const serverHost = join(import.meta.dir, "..", "..", "..", "server", "pty", "host.ts");
const { installedHostVouched }: { installedHostVouched(installed: string): boolean } = await import(serverHost);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** a server folder as the app carries it: package.json and bin/ovis-pty-sidecar with its install record */
function server(record: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-sign-mac-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.5.0" }));
  const host = join(dir, "bin", "ovis-pty-sidecar");
  writeFileSync(host, "unsigned host");
  const sha256 = createHash("sha256").update(readFileSync(host)).digest("hex");
  if (record) writeFileSync(`${host}.json`, JSON.stringify({ crate: "abc", sha256, version: "0.5.0" }));
  return host;
}

/** codesign as far as the record is concerned: it rewrites the binary in place */
const codesign = async (_file: string, args: string[]) => {
  appendFileSync(args.at(-1)!, " + signature");
  return "";
};

describe("signHost", () => {
  it("signs the host with the app's identity, and the server still runs it", async () => {
    const host = server(true);
    const calls: string[][] = [];
    await signHost(host, { identity: "HASH", keychain: "/k.keychain-db", entitlements: "/e.plist" }, async (file, args) => {
      calls.push([file, ...args]);
      return codesign(file, args);
    });
    expect(calls).toEqual([["codesign", "--sign", "HASH", "--force", "--timestamp", "--options", "runtime", "--entitlements", "/e.plist", "--keychain", "/k.keychain-db", host]]);
    expect(installedHostVouched(host)).toBe(true);
    expect(JSON.parse(readFileSync(`${host}.json`, "utf8")).crate).toBe("abc");
  });

  it("writes no record for a host that came without one", async () => {
    const host = server(false);
    await signHost(host, { identity: "HASH" }, codesign);
    expect(existsSync(`${host}.json`)).toBe(false);
  });
});
