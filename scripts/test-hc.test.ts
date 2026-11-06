import { afterAll, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedHcEnv, stopIsolatedCore } from "./test-hc.ts";

// A stand-in hc that writes down how it was run: no real core is started or stopped.
const root = mkdtempSync(join(tmpdir(), "ovis-test-hc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const record = join(root, "ran");
const bin = join(root, "hc");
writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$HC_SOCKET" "$OVIS_CANARY" > ${JSON.stringify(record)}\n`);
chmodSync(bin, 0o755);

it("never stops a core when the test's own core was never set up", async () => {
  // a setup that threw before its environment was made leaves it empty
  await stopIsolatedCore(bin, {});
  expect(existsSync(record)).toBe(false);
});

it("stops the test's own core, in its environment alone", async () => {
  process.env["OVIS_CANARY"] = "inherited";
  try {
    const env = isolatedHcEnv(join(root, "core"));
    await stopIsolatedCore(bin, env);
    expect(readFileSync(record, "utf8")).toBe(`server stop|${env["HC_SOCKET"]}|\n`);
  } finally {
    delete process.env["OVIS_CANARY"];
  }
});
