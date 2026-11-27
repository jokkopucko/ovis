import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../server/seen.ts";
import { persistSeen } from "../server/seen-persistence.ts";
import { writeStateDocument } from "../server/state-document.ts";

// Synthetic whole-store writes, paired on the same host. Counts are gates; times are distributions.
const results = [];
for (const answerLength of [128, 2048]) {
  for (const mode of ["sync-baseline", "async", "slow-async"] as const) {
    for (let repetition = 0; repetition < 5; repetition++) {
      const dir = mkdtempSync(join(tmpdir(), "seen-benchmark-"));
      const rows = Array.from({ length: 500 }, (_, pane) => ({ pc: "fixture", epoch: "e", pane: `p${pane}`, id: 1, answer: "x".repeat(answerLength) }));
      writeFileSync(join(dir, "seen.json"), JSON.stringify(rows));
      let writes = 0;
      let bytes = 0;
      let active = 0;
      let maxActive = 0;
      const delays: number[] = [];
      let previous = performance.now();
      const timer = setInterval(() => { const now = performance.now(); delays.push(now - previous); previous = now; }, 1);
      const start = performance.now();
      try {
        if (mode === "sync-baseline") {
          // Exact original algorithm: map copy, merge changed ID, replace file, rebuild map.
          let base = new Map(rows.map((row) => [row.pane, row]));
          for (let id = 2; id <= 51; id++) {
            const next = new Map(base);
            next.delete("p0");
            next.set("p0", { ...rows[0]!, id });
            const text = `${JSON.stringify([...next.values()])}\n`;
            writes++; bytes += Buffer.byteLength(text);
            writeStateDocument(join(dir, "seen.json"), text, false);
            base = new Map(next);
          }
        } else {
          const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
            writes++; bytes += Buffer.byteLength(text); maxActive = Math.max(maxActive, ++active);
            if (mode === "slow-async") await new Promise<void>((resolve) => setImmediate(resolve));
            try { await persistSeen(path, text, damaged); } finally { active--; }
          });
          await Promise.all(Array.from({ length: 50 }, (_, offset) => store.record({ ...rows[0]!, id: offset + 2 })));
          await store.record({ ...rows[0]!, id: 51 });
          await store.close();
          if (maxActive !== 1) throw new Error("Concurrent writers");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        delays.push(performance.now() - previous);
        // the store commits what waits behind a write in one write: the first, then the 49 behind it (the last is a repeat)
        const expected = mode === "sync-baseline" ? 50 : 2;
        if (writes !== expected) throw new Error(`Expected ${expected} writes, got ${writes}`);
        results.push({ answerLength, mode, repetition, writes, bytes, maxActive: mode === "sync-baseline" ? 1 : maxActive, elapsedMs: performance.now() - start, eventLoopGapsMs: delays });
      } finally { clearInterval(timer); rmSync(dir, { recursive: true, force: true }); }
    }
  }
}
console.log(JSON.stringify({ runtime: Bun.version, platform: process.platform, arch: process.arch, fixture: { records: 500, updates: 50, repetitions: 5, warmups: 0 }, results }, null, 2));
