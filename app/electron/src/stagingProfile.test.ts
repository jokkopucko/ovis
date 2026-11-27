import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStagingProfile, updateFeed, writeStagingMarker } from "./stagingProfile.ts";

const home = "/Users/preview";
const user = { homedir: home, uid: 501 };
let resources: string;

beforeEach(() => { resources = mkdtempSync(join(tmpdir(), "ovis-staging-profile-")); });
afterEach(() => rmSync(resources, { recursive: true, force: true }));

test("a staging marker supplies the launcher defaults and profile", () => {
  writeStagingMarker(resources, true);
  expect(readStagingProfile({ resources, user, env: {} })).toEqual({
    env: {
      HOME: "/Users/preview/.ost",
      CFFIXED_USER_HOME: "/Users/preview/.ost",
      HC_SESSION: "ost",
      OVIS_ACCOUNT_SERVICE_URL: "https://account-staging.devswha.workers.dev",
      OVIS_RELAY_URL: "wss://ovis-relay-staging.devswha.workers.dev",
      OVIS_RELAY_STAGING: "1",
      OVIS_RELAY_APP_URL: "https://relay-0510.ovis-app.pages.dev",
      OVIS_PREVIEW_PROFILE: "1",
    },
    userData: "/Users/preview/.ost/app",
  });
});

test("a preview (staging) build reads the preview feed alone, and no other build ever reads it", () => {
  const release = "https://github.com/devswha/ovis/releases/latest/download";
  const preview = "https://preview.example/mac/";
  expect(updateFeed({ OVIS_UPDATE_FEED: release, OVIS_PREVIEW_FEED: preview }, true)).toBe(preview);
  expect(updateFeed({ OVIS_UPDATE_FEED: release, OVIS_PREVIEW_FEED: preview }, false)).toBe(release);
  expect(updateFeed({ OVIS_PREVIEW_FEED: preview }, false)).toBeNull();
  expect(updateFeed({ OVIS_UPDATE_FEED: release }, true)).toBeNull();
});

test("an inherited login HOME still opens the staging home", () => {
  writeStagingMarker(resources, true);
  expect(readStagingProfile({ resources, user, env: { HOME: home } })?.env.HOME).toBe("/Users/preview/.ost");
});

test("explicit environment settings win over staging defaults, including empty values", () => {
  writeStagingMarker(resources, true);
  const env = {
    HOME: "/custom/home",
    CFFIXED_USER_HOME: "/custom/mac-home",
    HC_SESSION: "try",
    OVIS_ACCOUNT_SERVICE_URL: "off",
    OVIS_RELAY_URL: "wss://relay.example.test",
    OVIS_RELAY_STAGING: "0",
    OVIS_RELAY_APP_URL: "",
    OVIS_PREVIEW_PROFILE: "0",
    PATH: "/bin",
  };
  expect(readStagingProfile({ resources, user, env })).toEqual({
    env,
    userData: "/Users/preview/.ost/app",
  });
});

test("the socket budget includes the staging home and effective session", () => {
  writeStagingMarker(resources, true);
  const longHome = `/Users/${"a".repeat(21)}`;
  const longUser = { ...user, homedir: longHome };
  expect(readStagingProfile({ resources, user: longUser, env: {} })?.env.HOME).toBe(`${longHome}/.ost`);
  const profile = readStagingProfile({ resources, user: longUser, env: { HC_SESSION: "long" } });
  expect(profile?.env).toMatchObject({ HOME: "/tmp/ost-501", CFFIXED_USER_HOME: "/tmp/ost-501", HC_SESSION: "long" });
  expect(profile?.userData).toBe("/tmp/ost-501/app");
});

test("a non-staging package clears any marker left in the reused stage", () => {
  const env = { HOME: home, HC_SESSION: "keep" };
  expect(readStagingProfile({ resources, user, env })).toBeNull();
  writeStagingMarker(resources, true);
  expect(existsSync(join(resources, "staging.json"))).toBe(true);
  writeStagingMarker(resources, false);
  expect(existsSync(join(resources, "staging.json"))).toBe(false);
  expect(readStagingProfile({ resources, user, env })).toBeNull();
  expect(env).toEqual({ HOME: home, HC_SESSION: "keep" });
});

test("an invalid marker does not silently open the release profile", () => {
  writeFileSync(join(resources, "staging.json"), "{}");
  expect(() => readStagingProfile({ resources, user, env: {} })).toThrow("Invalid staging marker");
});
