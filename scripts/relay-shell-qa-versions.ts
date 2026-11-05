import assert from "node:assert/strict";
import { compareVersions, parseVersion } from "../src/lib/relay/skew.ts";

/** Pure fixture setup, separate from the browser script so unit tests start no PC or herdr. */
export function relayShellQaVersions(shellVersion: string, minServerVersion: string): { readonly below: string; readonly newer: string } {
  const shell = parseVersion(shellVersion);
  const minimum = parseVersion(minServerVersion);
  assert.ok(shell);
  assert.ok(minimum);
  // An unreleased shell below MIN admits its own server, so the old PC must be below both.
  const [major, minor, patch] = compareVersions(shell, minimum) < 0 ? shell : minimum;
  assert.ok(major > 0 || minor > 0 || patch > 0, "no older PC exists below a 0.0.0 floor");
  const below = patch > 0 ? `${major}.${minor}.${patch - 1}`
    : minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`;
  const newer = `${shell[0]}.${shell[1] + 1}.0`;
  assert.ok(parseVersion(below), "the older PC fixture has a valid version");
  assert.ok(parseVersion(newer), "the newer PC fixture has a valid version");
  return { below, newer };
}
