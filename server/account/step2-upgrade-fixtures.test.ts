import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["", "1"])("missing release fixtures are visible and mandatory in CI=%s", async ci => {
  const empty = mkdtempSync(join(tmpdir(), "release-objects-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { hasReleaseFixtures, v057Fixture } from "./server/account/step2-upgrade-v057.test-helpers.ts";
      if (hasReleaseFixtures("v0.5.6", "v0.5.7")) await v057Fixture(process.env.GIT_OBJECT_DIRECTORY + "/checkout");
    `], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, GIT_MASTER: "1", GIT_OBJECT_DIRECTORY: empty, GIT_ALTERNATE_OBJECT_DIRECTORIES: "", CI: ci },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(ci ? 1 : 0);
    expect(stderr).toContain("v0.5.7");
    expect(stderr).toContain("git fetch origin tag v0.5.7");
    if (!ci) expect(stderr).toContain("v0.5.6");
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
