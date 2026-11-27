import { describe, expect, it } from "bun:test";
import { APPROVAL_ADAPTERS } from "../server/approvals/adapters.ts";
import { drifted, HARNESSES, type Harness } from "./harness-drift.ts";

describe("harness drift", () => {
  const measuredOn1 = (kind: string): Harness => ({ kind, npm: kind, link: "Ovis's hook", supports: (version) => version.startsWith("1.") });

  it("lists a CLI whose latest release is outside its window, and one whose release was not read, never one inside", () => {
    const rows = drifted([measuredOn1("inside"), measuredOn1("outside"), measuredOn1("unread")], new Map([
      ["inside", { version: "1.4.2" }],
      ["outside", { version: "2.0.0" }],
      ["unread", { error: "npm answered 503" }],
    ]));
    expect(rows.map(({ kind, latest, outside }) => [kind, latest, outside])).toEqual([["outside", "2.0.0", true], ["unread", "npm answered 503", false]]);
  });

  it("checks every hooked agent and Codex's own server against the windows in the code", () => {
    // every window starts at the version it was measured from: a release older than all of them is outside each one
    const rows = drifted(HARNESSES, new Map(HARNESSES.map((harness) => [harness.kind, { version: "0.0.1" }])));
    expect(rows.map((row) => [row.kind, row.outside])).toEqual([...APPROVAL_ADAPTERS.map((adapter) => adapter.kind), "codex"].map((kind) => [kind, true]));
  });
});
