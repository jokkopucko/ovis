import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConsumedReplay, rememberCodexConsumed } from "./codex-consumed.ts";

it("keeps the oldest receipt at capacity and does not acknowledge a different copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-consumed-"));
  try {
    expect(rememberCodexConsumed(dir, "oldest", "p", "original")).toBe(true);
    const db = new Database(join(dir, "codex-consumed.sqlite"));
    try {
      // Fill the remaining slots in one transaction rather than fsyncing 4,095 times.
      db.run("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4095) INSERT INTO consumed SELECT CAST(i AS TEXT), 'other' FROM n");
    } finally { db.close(); }
    expect(rememberCodexConsumed(dir, "new", "p", "later")).toBe(false);
    expect(codexConsumedReplay(dir, "oldest", "p", "original")).toBe("same");
    expect(codexConsumedReplay(dir, "oldest", "p", "edited")).toBe("different");
    expect(codexConsumedReplay(dir, "oldest", "another pane", "original")).toBe("different");
    expect(codexConsumedReplay(dir, "new", "p", "later")).toBe("unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
