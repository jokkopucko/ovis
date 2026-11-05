import { describe, expect, it } from "bun:test";
import { MIN_SERVER_VERSION, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { compareVersions, parseVersion, relaySkew, reloadOnce } from "./skew.ts";

const skew = (server: string, shell = "0.5.3", relayProtocol = RELAY_PROTOCOL) =>
  relaySkew({ server: { version: server, relayProtocol }, shellVersion: shell, minServerVersion: "0.5.0" });

class Memory {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("relaySkew", () => {
  it("connects a server at the shell's own version", () => {
    expect(skew("0.5.3")).toBe("ok");
  });

  it("connects a previous server at or above the minimum", () => {
    expect(skew("0.5.0")).toBe("ok");
    expect(skew("0.5.2")).toBe("ok");
  });

  it("sends a server below the minimum to the update screen", () => {
    expect(skew("0.4.99")).toBe("pc-outdated");
    expect(skew("0.4.20", "0.5.3")).toBe("pc-outdated");
  });

  it("stops at a relay protocol mismatch whatever the versions say", () => {
    expect(skew("0.5.3", "0.5.3", RELAY_PROTOCOL + 1)).toBe("protocol-mismatch");
    expect(skew("0.4.0", "0.5.3", 0)).toBe("protocol-mismatch");
  });

  it("reloads onto a newer shell when the server is newer", () => {
    expect(skew("0.5.4")).toBe("server-newer");
    expect(skew("0.6.0")).toBe("server-newer");
  });

  it("lets an unreleased checkout below the minimum reach its own server, and no older one", () => {
    // package.json still names the last release while the minimum names the next one
    expect(relaySkew({ server: { version: "0.4.20", relayProtocol: RELAY_PROTOCOL }, shellVersion: "0.4.20" })).toBe("ok");
    expect(relaySkew({ server: { version: "0.4.19", relayProtocol: RELAY_PROTOCOL }, shellVersion: "0.4.20" })).toBe("pc-outdated");
    expect(relaySkew({ server: { version: MIN_SERVER_VERSION, relayProtocol: RELAY_PROTOCOL }, shellVersion: MIN_SERVER_VERSION })).toBe("ok");
  });

  it("treats a version it cannot read as outdated, never as newer", () => {
    for (const garbage of ["", "test", "v0.5.3", "0.5", "0.5.3.1", "1e3.0.0", "0.5.x", "-1.0.0", " ", "0.5.3-", "9".repeat(10) + ".0.0"]) {
      expect(skew(garbage)).toBe("pc-outdated");
    }
  });

  it("treats a malformed pre-release or build suffix as outdated, never as newer", () => {
    for (const garbage of ["9.0.0-+", "9.0.0-.", "9.0.0+..", "9.0.0-rc..1", "9.0.0-", "9.0.0+", "9.0.0-rc.", "9.0.0-.rc",
      "9.0.0+build.", "9.0.0-rc_1", "9.0.0-rc+", "9.0.0+a+b", "9.0.0-01", "09.0.0", "9.00.0", "9.0.0 ", " 9.0.0", `9.0.0-${"a".repeat(64)}`]) {
      expect(parseVersion(garbage)).toBeNull();
      expect(relaySkew({ server: { version: garbage, relayProtocol: RELAY_PROTOCOL }, shellVersion: "0.4.20" })).toBe("pc-outdated");
    }
  });

  it("reads every well-formed SemVer suffix", () => {
    for (const valid of ["9.0.0-rc.1", "9.0.0-0", "9.0.0-x-y.7", "9.0.0-0a", "9.0.0+001", "9.0.0-alpha.1+build.5-x", "9.0.0+exp.sha.5114f85"]) {
      expect(parseVersion(valid)).toEqual([9, 0, 0]);
    }
  });

  it("compares the release, not its suffix", () => {
    expect(skew("0.5.3-rc.1")).toBe("ok");
    expect(skew("0.5.4+build.7")).toBe("server-newer");
  });

  it("skips the newer check when the shell's own version is unreadable", () => {
    expect(skew("9.9.9", "dev")).toBe("ok");
    expect(skew("0.4.0", "dev")).toBe("pc-outdated");
  });
});

describe("versions", () => {
  it("orders numerically, not as text", () => {
    expect(compareVersions(parseVersion("0.10.0")!, parseVersion("0.9.9")!)).toBeGreaterThan(0);
    expect(compareVersions(parseVersion("0.4.20")!, parseVersion("0.4.21")!)).toBeLessThan(0);
    expect(compareVersions(parseVersion("1.2.3")!, parseVersion("1.2.3")!)).toBe(0);
  });

  it("starts the minimum at a release version", () => {
    expect(parseVersion(MIN_SERVER_VERSION)).not.toBeNull();
  });
});

describe("reloadOnce", () => {
  it("reloads once for a pair, then connects on the same stale shell instead of looping", () => {
    const memory = new Memory();
    expect(reloadOnce(memory, "0.5.3", "0.5.4")).toBe(true);
    expect(reloadOnce(memory, "0.5.3", "0.5.4")).toBe(false);
    expect(reloadOnce(memory, "0.5.3", "0.5.4")).toBe(false);
  });

  it("keeps a receipt per pair, so going back to an earlier PC does not reload again", () => {
    const memory = new Memory();
    expect(["0.5.4", "0.5.5", "0.5.4", "0.5.5"].map((server) => reloadOnce(memory, "0.5.3", server))).toEqual([true, true, false, false]);
  });

  it("bounds the receipts, forgetting the oldest pair first", () => {
    const memory = new Memory();
    for (let patch = 0; patch < 17; patch++) expect(reloadOnce(memory, "0.5.3", `0.6.${patch}`)).toBe(true);
    expect(JSON.parse(memory.getItem("ovis:relay-skew-reloads")!)).toHaveLength(16);
    expect(reloadOnce(memory, "0.5.3", "0.6.16")).toBe(false);
    expect(reloadOnce(memory, "0.5.3", "0.6.0")).toBe(true);
  });

  it("starts over from a damaged receipt instead of failing", () => {
    const memory = new Memory();
    memory.setItem("ovis:relay-skew-reloads", "{not json");
    expect(reloadOnce(memory, "0.5.3", "0.5.4")).toBe(true);
    expect(reloadOnce(memory, "0.5.3", "0.5.4")).toBe(false);
  });

  it("reloads again for a server that moved on since", () => {
    const memory = new Memory();
    expect(reloadOnce(memory, "0.5.3", "0.5.4")).toBe(true);
    expect(reloadOnce(memory, "0.5.3", "0.5.5")).toBe(true);
  });

  it("never reloads when the tab cannot remember it did", () => {
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(reloadOnce(throwing, "0.5.3", "0.5.4")).toBe(false);
    const forgetful = { getItem: () => null, setItem: () => undefined };
    expect(reloadOnce(forgetful, "0.5.3", "0.5.4")).toBe(false);
  });
});
