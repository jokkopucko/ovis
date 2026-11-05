import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseWorkflow, root } from "./shell-workflow-rules.ts";

const workflow = (name: string) => parseWorkflow(join(root, ".github/workflows", name));
const ATTESTS = { contents: "read", "id-token": "write", attestations: "write" };

test("release and repair runs attest every Rust PTY host binary; pull requests and the build jobs get no signing token", () => {
  const sidecar = workflow("pty-sidecar.yml");
  expect(sidecar.permissions).toEqual({ contents: "read" });
  for (const name of ["build", "manifest"]) expect(sidecar.jobs[name]!.permissions).toBeUndefined();
  const attest = sidecar.jobs["attest"]!;
  expect(attest.needs).toBe("manifest");
  expect(attest.if).toBe("github.event_name != 'pull_request' && (inputs.ref == github.sha || inputs.ref == github.ref)");
  expect(attest.permissions).toEqual(ATTESTS);
  const download = attest.steps!.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(download?.with).toEqual({ name: "ovis-pty-sidecar", path: "pty-sidecar" });
  const step = attest.steps!.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  expect(step?.uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
  expect(step?.with).toEqual({ "subject-path": "pty-sidecar/ovis-pty-sidecar-*" });
});

test("every caller grants the attest job its permissions, and Release publishes only after it", () => {
  const release = workflow("release.yml");
  expect(release.jobs["pty-sidecar"]!.permissions).toEqual(ATTESTS);
  expect(release.jobs["publish"]!.needs).toContain("pty-sidecar");
  expect(workflow("pty-sidecar-attach.yml").jobs["build"]!.permissions).toEqual(ATTESTS);
  expect(workflow("beta.yml").jobs["host-build"]!.permissions).toEqual(ATTESTS);
});
