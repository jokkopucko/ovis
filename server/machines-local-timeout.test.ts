import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { HerdrError } from "./herdr/client.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

async function fixture(initialFailure = false) {
  const root = mkdtempSync(join(tmpdir(), "ovis-local-timeout-"));
  const snapshot: SessionSnapshot = { protocol: 22, version: "fixture", workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
  let failure: Error | null = initialFailure ? new HerdrError("timeout", "fixture timeout") : null;
  const first = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
  const manager = new MachineManager(root, push, new CompletionTracker(null), async () => {
    await first.promise;
    if (failure) throw failure;
    return snapshot;
  });
  const unsubscribe = manager.subscribe(() => published.resolve());
  cleanups.push(() => { unsubscribe(); manager.stop(); rmSync(root, { recursive: true, force: true }); });
  first.resolve();
  await published.promise;
  return { manager, snapshot, fail(code = "timeout") { failure = new HerdrError(code, `fixture ${code}`); }, recover() { failure = null; } };
}

it("keeps a connected roster through one timeout, but exposes the second", async () => {
  const f = await fixture();
  f.fail();
  await f.manager.refreshLocal();
  expect(f.manager.list()[0]).toMatchObject({ state: "connected", error: null, snapshot: f.snapshot });
  await f.manager.refreshLocal();
  expect(f.manager.list()[0]).toMatchObject({ state: "error", error: "fixture timeout", snapshot: f.snapshot });
});

it("resets the timeout streak on a successful snapshot", async () => {
  const f = await fixture();
  f.fail();
  await f.manager.refreshLocal();
  f.recover();
  await f.manager.refreshLocal();
  f.fail();
  await f.manager.refreshLocal();
  expect(f.manager.list()[0]).toMatchObject({ state: "connected", error: null });
});

it("reports a first startup timeout without claiming a connection", async () => {
  const f = await fixture(true);
  expect(f.manager.list()[0]).toMatchObject({ state: "error", snapshot: null });
});

it("reports a definite transport failure immediately and recovers on success", async () => {
  const f = await fixture();
  f.fail("connect_failed");
  await f.manager.refreshLocal();
  expect(f.manager.list()[0]).toMatchObject({ state: "error", error: "fixture connect_failed" });
  f.recover();
  await f.manager.refreshLocal();
  expect(f.manager.list()[0]).toMatchObject({ state: "connected", error: null });
});
