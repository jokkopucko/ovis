import { expect, it } from "bun:test";
import { RELAY_PROTOCOL } from "../shared/relay-mux.ts";
import { parseVersion, relaySkew } from "../src/lib/relay/skew.ts";
import { relayShellQaVersions } from "./relay-shell-qa-versions.ts";

it.each([
  { shell: "0.4.21", minimum: "0.4.21", below: "0.4.20", newer: "0.5.0" },
  { shell: "0.4.21-rc.1+build.2", minimum: "0.4.21-rc.2", below: "0.4.20", newer: "0.5.0" },
  { shell: "0.4.0", minimum: "0.4.0", below: "0.3.0", newer: "0.5.0" },
  { shell: "1.0.2", minimum: "1.0.2", below: "1.0.1", newer: "1.1.0" },
  { shell: "1.0.0", minimum: "1.0.0", below: "0.0.0", newer: "1.1.0" },
  { shell: "0.4.19", minimum: "0.4.21", below: "0.4.18", newer: "0.5.0" },
  { shell: "1.2.3", minimum: "0.4.21", below: "0.4.20", newer: "1.3.0" },
  { shell: "0.4.999999999", minimum: "0.4.21", below: "0.4.20", newer: "0.5.0" },
])("derives skew PCs for shell $shell and minimum $minimum", ({ shell, minimum, below, newer }) => {
  const versions = relayShellQaVersions(shell, minimum);
  expect(versions).toEqual({ below, newer });
  for (const [version, state] of [[versions.below, "pc-outdated"], [versions.newer, "server-newer"]] as const) {
    expect(parseVersion(version)).not.toBeNull();
    expect(relaySkew({ server: { version, relayProtocol: RELAY_PROTOCOL }, shellVersion: shell, minServerVersion: minimum })).toBe(state);
  }
});

it.each(["0.0.0", "0.999999999.0"])("rejects an unsupported fixture boundary at %s", (version) => {
  expect(() => relayShellQaVersions(version, version)).toThrow();
});
