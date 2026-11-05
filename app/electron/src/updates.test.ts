import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BETA_FEED, updateChannel, updatePlan } from "./updates.ts";

const packaged = { packaged: true, platform: "darwin", builtWithFeed: true, env: {} };

describe("updatePlan", () => {
  it("updates a packaged build from the feed it was built with", () => {
    expect(updatePlan(packaged)).toEqual({ enabled: true, feed: null, channel: "stable" });
  });

  it("never updates a development run, or with OVIS_UPDATES=0", () => {
    expect(updatePlan({ ...packaged, packaged: false }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATES: "0" } }).enabled).toBe(false);
  });

  it("has nothing to update from without a feed", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false })).toEqual({ enabled: false, reason: "this build has no update feed" });
  });

  it("takes OVIS_UPDATE_URL over the built feed, https only", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false, env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: true, feed: "https://updates.example/desktop", channel: "stable" });
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "http://updates.example/desktop" } }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "not an address" } }).enabled).toBe(false);
  });

  it("updates on Linux only as an AppImage", () => {
    expect(updatePlan({ ...packaged, platform: "linux" }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, platform: "linux", env: { APPIMAGE: "/home/u/Ovis.AppImage" } }).enabled).toBe(true);
  });

  it("takes the beta builds from the beta feed only on the beta channel", () => {
    expect(updatePlan({ ...packaged, channel: "beta" })).toEqual({ enabled: true, feed: BETA_FEED, channel: "beta" });
    expect(updatePlan({ ...packaged, channel: "stable" })).toEqual({ enabled: true, feed: null, channel: "stable" });
    // a build without a feed stays off, and OVIS_UPDATE_URL stays the feed on beta
    expect(updatePlan({ ...packaged, builtWithFeed: false, channel: "beta" }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, channel: "beta", env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: true, feed: "https://updates.example/desktop", channel: "beta" });
  });
});

describe("updateChannel", () => {
  it("reads OVIS_UPDATE_CHANNEL, then the server state dir's update-channel file, else stable", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-desktop-channel-"));
    try {
      expect(updateChannel({}, stateDir)).toBe("stable");
      writeFileSync(join(stateDir, "update-channel"), "beta\n");
      expect(updateChannel({}, stateDir)).toBe("beta");
      expect(updateChannel({ OVIS_UPDATE_CHANNEL: "stable" }, stateDir)).toBe("stable");
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});
