import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { createServer } from "./index.ts";
import { MachineManager } from "./machines.ts";
import { createPushService } from "./push.ts";

describe("slow structural roster refreshes", () => {
  for (const remote of [false, true]) {
    it(`publishes each slow ${remote ? "remote" : "local"} roster while structural changes continue`, async () => {
      const root = mkdtempSync(join(tmpdir(), "ovis-test-slow-roster-"));
      const workspace = await workspaceCreate({ cwd: root, label: "ovis-test-slow-roster" });
      let manager: MachineManager | undefined;
      let bridge: ReturnType<typeof Bun.serve> | undefined;
      let pending: { snapshot: SessionSnapshot; resolve: (snapshot: SessionSnapshot) => void } | undefined;
      const order: string[] = [];
      let entered = Promise.withResolvers<void>();
      let parked = Promise.withResolvers<void>();
      let held = false;
      const read = async (): Promise<SessionSnapshot> => {
        if (!held) return sessionSnapshot();
        order.push("read");
        entered.resolve();
        const snapshot = await sessionSnapshot();
        return new Promise((resolve) => { pending = { snapshot, resolve }; parked.resolve(); });
      };
      try {
        const ready = Promise.withResolvers<void>();
        manager = new MachineManager(root, createPushService({ stateDir: root }), new CompletionTracker(null), remote ? sessionSnapshot : read);
        const unsubscribe = manager.subscribe((event) => {
          if (event.type === "machines" && event.machines[0]?.state === "connected") ready.resolve();
        });
        await ready.promise;
        unsubscribe();
        type TestRuntime = { machine: Machine; endpoint?: { url: string; token: string }; ssh?: { close(): void; onExit?: () => void } };
        const drive = manager as unknown as {
          machines: Map<string, TestRuntime>;
          runtime(machine: Machine): TestRuntime;
          refresh(runtime: TestRuntime): Promise<void>;
          observe(runtime: TestRuntime): Promise<void>;
        };
        const runtime = drive.runtime({ id: "remote", name: "Slow fixture", kind: "ssh", enabled: true, state: "connected", error: null, snapshot: null });
        let observer: { send(data: string): unknown } | undefined;
        if (remote) {
          const observing = Promise.withResolvers<void>();
          bridge = Bun.serve({
            port: 0, hostname: "127.0.0.1",
            async fetch(request, server) {
              const { pathname } = new URL(request.url);
              if (pathname === "/ws" && server.upgrade(request, { data: undefined })) return;
              if (pathname !== "/api/session") return new Response(null, { status: 404 });
              return Response.json({ snapshot: await read() });
            },
            websocket: {
              open(ws) { observer = ws; },
              message(_ws, data) { if (JSON.parse(String(data)).type === "role") observing.resolve(); },
            },
          });
          runtime.endpoint = { url: `http://127.0.0.1:${bridge.port}`, token: "fixture" };
          runtime.ssh = { close() {} };
          drive.machines.set("remote", runtime);
          await drive.observe(runtime);
          await observing.promise;
        }
        held = true;
        const loading = remote ? drive.refresh(runtime) : manager.refreshLocal();
        for (let pass = 0; pass < 4; pass++) {
          await parked.promise;
          const response = pending;
          if (!response) throw new Error("held roster missing");
          pending = undefined;
          parked = Promise.withResolvers<void>();
          entered = Promise.withResolvers<void>();
          const marker = `ovis-test-slow-roster-held-${pass}`;
          const marked = { ...response.snapshot, workspaces: response.snapshot.workspaces.map((item) => item.workspace_id === workspace.workspace.workspace_id ? { ...item, label: marker } : item) };
          let published = false;
          const stopListening = manager.subscribe((event) => {
            if (event.type !== "machines" || published) return;
            const snapshot = remote ? runtime.machine.snapshot : event.machines[0]?.snapshot;
            if (snapshot?.workspaces.some((item) => item.label === marker)) { published = true; order.push(marker); }
          });
          const since = order.length;
          if (remote) {
            const invalidated = Promise.withResolvers<void>();
            const stopWaiting = manager.subscribe((event) => {
              if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "session-changed") invalidated.resolve();
            });
            if (!observer) throw new Error("remote observer missing");
            observer.send(JSON.stringify({ type: "session-changed" }));
            await invalidated.promise;
            stopWaiting();
          } else manager.localMessage({ type: "session-changed" });
          const nextRead = entered.promise;
          response.resolve(marked);
          await nextRead;
          stopListening();
          expect(order.slice(since)).toEqual([marker, "read"]);
        }
        held = false;
        await parked.promise;
        if (!pending) throw new Error("follow-up roster missing");
        pending.resolve(pending.snapshot);
        await loading;
      } finally {
        manager?.stop();
        if (pending) pending.resolve(pending.snapshot);
        bridge?.stop(true);
        await workspaceClose(workspace.workspace.workspace_id);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("workspace order evidence across a real bridge", () => {
  it("relays the source's own move receipt, and the roster carries the source's pairs untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-test-order-bridge-"));
    const first = await workspaceCreate({ cwd: root, label: "ovis-test-order-bridge-first" });
    const second = await workspaceCreate({ cwd: root, label: "ovis-test-order-bridge-second" });
    const managedBoot = process.env["OVIS_BOOT_ID"];
    delete process.env["OVIS_BOOT_ID"];
    const token = "test-order-bridge-token";
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, stateDir: join(root, "bridge"), tailscaleOwner: null });
    let clock = 0;
    const manager = new MachineManager(join(root, "manager"), createPushService({ stateDir: root }), new CompletionTracker(null), sessionSnapshot, { bootId: "manager-boot", now: () => clock });
    try {
      const url = `http://127.0.0.1:${bridge.port}`;
      const sourceBoot = ((await (await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` } })).json()) as { web_ui: { boot_id: string } }).web_ui.boot_id;
      type TestRuntime = { machine: Machine; endpoint?: { url: string; token: string }; ssh?: { close(): void } };
      const drive = manager as unknown as { machines: Map<string, TestRuntime>; runtime(machine: Machine): TestRuntime; observe(runtime: TestRuntime): Promise<void> };
      const runtime = drive.runtime({ id: "remote", name: "Order fixture", kind: "ssh", enabled: true, state: "connected", error: null, snapshot: null });
      runtime.endpoint = { url, token };
      runtime.ssh = { close() {} };
      drive.machines.set("remote", runtime);
      const remoteWhere = (check: (machine: Machine) => boolean) => new Promise<Machine>((resolve) => {
        const stop = manager.subscribe((event) => {
          const machine = event.type === "machines" ? event.machines.find((item) => item.id === "remote") : undefined;
          if (machine && check(machine)) { queueMicrotask(stop); resolve(machine); }
        });
      });
      const proved = remoteWhere((machine) => machine.source_boot_id === sourceBoot && machine.snapshot?.order_epoch === sourceBoot);
      await drive.observe(runtime);
      // the proof is the bridge's own health over the manager's connection, never the manager's boot
      expect(await proved).toMatchObject({ source_boot_id: sourceBoot, snapshot: { order_epoch: sourceBoot, read_seq: 0 } });
      const after = remoteWhere((machine) => (machine.snapshot?.read_seq ?? 0) >= 1);
      const moved = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/workspace/move", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ workspace_id: second.workspace.workspace_id, insert_index: 0 }),
      }), manager);
      expect(moved.status).toBe(200);
      expect(await moved.json()).toEqual({ ok: true, order_epoch: sourceBoot, moved_seq: 1 });
      expect((await after).snapshot).toMatchObject({ order_epoch: sourceBoot, read_seq: 1 });
      const local = manager.list()[0]!;
      expect(local.source_boot_id).toBe("manager-boot");
      clock = 10_000;
      const verified = await handleMachineRequest(new Request("http://127.0.0.1/api/machines?verify_source_boot=remote"), manager);
      expect(verified.status).toBe(200);
      const body = await verified.json() as { machines: Machine[]; verified_source_boot: unknown };
      expect(body.verified_source_boot).toEqual({ machine_id: "remote", boot_id: sourceBoot });
      expect(JSON.stringify(body)).not.toContain(token);
      expect(body.machines.find((machine) => machine.id === "remote")?.snapshot).toMatchObject({ order_epoch: sourceBoot });
    } finally {
      manager.stop();
      bridge.stop();
      if (managedBoot === undefined) delete process.env["OVIS_BOOT_ID"]; else process.env["OVIS_BOOT_ID"] = managedBoot;
      await workspaceClose(first.workspace.workspace_id).catch(() => {});
      await workspaceClose(second.workspace.workspace_id).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
