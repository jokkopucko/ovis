import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processCodexHome } from "./codex.ts";

it.skipIf(process.platform !== "linux").each([
  { label: "a project store with an open database and rollout", stores: 1, rollout: true, explicit: false, found: true },
  { label: "an unrelated open database", stores: 1, rollout: false, explicit: false, found: false },
  { label: "ambiguous open stores", stores: 2, rollout: true, explicit: false, found: false },
  { label: "two held stores with an inaccessible database", stores: 2, rollout: true, explicit: false, inspectFailure: "database", found: false },
  { label: "two held stores with a missing rollout path", stores: 2, rollout: true, explicit: false, inspectFailure: "rollout", found: false },
  { label: "an unrelated descriptor closing during enumeration", stores: 1, rollout: true, explicit: false, closedDescriptor: "unrelated", found: true },
  { label: "a candidate descriptor closing during rechecking", stores: 1, rollout: true, explicit: false, closedDescriptor: "candidate", found: false },
  { label: "an explicit CODEX_HOME", stores: 1, rollout: true, explicit: true, found: true },
  { label: "an empty CODEX_HOME", stores: 1, rollout: true, explicit: false, named: "", found: true },
  { label: "an invalid explicit CODEX_HOME", stores: 1, rollout: true, explicit: false, named: "relative", found: false },
  { label: "a noninteractive rollout", stores: 1, rollout: true, explicit: false, source: "exec", found: false },
  { label: "a replaced database path", stores: 1, rollout: true, explicit: false, replace: true, found: false },
  { label: "an incomplete descriptor scan", stores: 1, rollout: true, explicit: false, overflow: true, found: false },
])("resolves $label", async ({ stores, rollout, explicit, found, named, source, replace, overflow, inspectFailure, closedDescriptor }) => {
  const root = mkdtempSync(join(tmpdir(), "ovis-codex-process-store-"));
  const homes = Array.from({ length: stores }, (_, index) => join(root, `project ${index}`, ".codex"));
  const files: string[] = [];
  for (const home of homes) {
    mkdirSync(join(home, "sessions", "2026", "11", "13"), { recursive: true });
    const database = join(home, "state_5.sqlite");
    writeFileSync(database, "");
    files.push(database);
    if (rollout) {
      const transcript = join(home, "sessions", "2026", "11", "13", "rollout-test.jsonl");
      writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { source: source ?? "cli" } }) + "\n");
      files.push(transcript);
    }
  }
  const explicitHome = join(root, "explicit");
  mkdirSync(explicitHome);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CODEX_HOME"));
  const child = Bun.spawn([process.execPath, "-e", `
    const { openSync } = require("node:fs");
    const { closeSync } = require("node:fs");
    const { createInterface } = require("node:readline");
    const files = JSON.parse(process.env.OVIS_TEST_OPEN_FILES);
    const descriptors = files.map(path => openSync(path, "r"));
    if (process.env.OVIS_TEST_OVERFLOW === "1") for (let i = 0; i < 513; i++) descriptors.push(openSync(files[0], "r"));
    console.log("ready");
    for await (const line of createInterface({ input: process.stdin })) {
      if (line === "close") for (const fd of descriptors.splice(0)) closeSync(fd);
      if (line === "open") for (const file of files) descriptors.push(openSync(file, "r"));
      console.log(line);
    }
  `], {
    env: { ...env, OVIS_TEST_OPEN_FILES: JSON.stringify(files), OVIS_TEST_OVERFLOW: overflow ? "1" : "0",
      ...(named !== undefined ? { CODEX_HOME: named } : {}), ...(explicit ? { CODEX_HOME: explicitHome } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const spies: { mockRestore(): void }[] = [];
  let injected = 0;
  try {
    const reader = child.stdout.getReader();
    await reader.read();
    if (inspectFailure) {
      const inaccessible = files[inspectFailure === "database" ? 2 : 3]!;
      const stat = fs.statSync;
      spies.push(spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
        if (args[0] === inaccessible) {
          injected++;
          throw Object.assign(new Error("candidate path cannot be inspected"), { code: inspectFailure === "database" ? "EACCES" : "ENOENT" });
        }
        return stat(...args);
      }) as typeof fs.statSync));
    }
    if (closedDescriptor) {
      const readlink = fs.readlinkSync;
      let candidateReads = 0;
      spies.push(spyOn(fs, "readlinkSync").mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) => {
        if (closedDescriptor === "unrelated" && args[0] === `/proc/${child.pid}/fd/0`) {
          injected++;
          throw Object.assign(new Error("descriptor closed"), { code: "ENOENT" });
        }
        const path = readlink(...args);
        if (closedDescriptor === "candidate" && path === files[0] && ++candidateReads === 2) {
          injected++;
          throw Object.assign(new Error("descriptor closed during recheck"), { code: "ENOENT" });
        }
        return path;
      }) as typeof fs.readlinkSync));
    }
    if (replace) {
      const database = files[0]!;
      renameSync(database, `${database}.old`);
      writeFileSync(database, "replacement");
    }
    expect(await processCodexHome(child.pid)).toBe(explicit ? explicitHome : found ? homes[0]! : null);
    if (inspectFailure || closedDescriptor) expect(injected).toBeGreaterThan(0);
    if (found && !explicit) {
      // Neither an inferred store nor its absence can survive a descriptor change in the cache.
      child.stdin.write("close\n");
      await child.stdin.flush();
      await reader.read();
      expect(await processCodexHome(child.pid)).toBeNull();
      child.stdin.write("open\n");
      await child.stdin.flush();
      await reader.read();
      expect(await processCodexHome(child.pid)).toBe(homes[0]!);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
