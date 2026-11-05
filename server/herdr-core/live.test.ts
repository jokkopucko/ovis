import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, paneMoveToNewTab, ping, sessionSnapshot, tabRename, workspaceClose, workspaceCreate, workspaceRename } from "../herdr/client.ts";
import { startHerdrCoreAdapter } from "./adapter.ts";
import { CoreAttachSession } from "./attach-session.ts";
import { HcConnection } from "./connection.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

/**
 * The hc client against a real hc, in a core of its own: a session name and state, config and
 * runtime folders no other core uses, so the user's core and the Herdr app never see it. Runs only
 * where OVIS_TEST_HC_BIN names an hc (generation 1).
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

const WAIT_MS = 5000;
/** each test and hook outlasts its own bounded waits and calls, so a failure names the wait that ran out */
const TEST_MS = 30_000;

interface Waiter { check: () => boolean; resolve: () => void }

describe.skipIf(!bin)("hc client against a real hc", () => {
  let dir = "";
  /** set only once every isolating variable is in it: nothing runs hc without it */
  let env: Record<string, string> | null = null;
  /** the core and holder this test started, stopped (or killed) in afterAll */
  let pids: number[] = [];
  let hc: HcConnection;
  const waiters = new Set<Waiter>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-hc-live-"));
    for (const sub of ["state", "config", "run"]) mkdirSync(join(dir, sub), { mode: 0o700 });
    // an inherited HC_* (a terminal of the user's core, its socket) must not point this test at that core
    const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("HC_") && entry[1] !== undefined);
    const isolated = {
      ...Object.fromEntries(inherited),
      HC_SESSION: `ovis-test-${process.pid}`,
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_RUNTIME_DIR: join(dir, "run"),
      HC_SOCKET: join(dir, "run", "hc.sock"),
    };
    env = isolated;
    const started = Bun.spawn([bin!, "server", "start"], { env: isolated, stdout: "ignore", stderr: "pipe" });
    expect({ exit: await started.exited, stderr: await new Response(started.stderr).text() }).toMatchObject({ exit: 0 });
    const status = Bun.spawn([bin!, "server", "status", "--json"], { env: isolated, stdout: "pipe", stderr: "ignore" });
    const running = JSON.parse(await new Response(status.stdout).text()) as { pid: number; holder?: { pid: number } | null };
    pids = [running.pid, ...(running.holder ? [running.holder.pid] : [])];
    // spawnHcConnect would run hc with the env this process started with: this core's env is passed explicitly
    hc = new HcConnection(() => {
      const child = Bun.spawn([bin!, "connect"], { env: isolated, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      return {
        readable: child.stdout,
        write: (bytes: Uint8Array) => { child.stdin.write(bytes); void child.stdin.flush(); },
        exited: child.exited,
        kill: () => child.kill(),
      };
    });
  }, TEST_MS);

  afterAll(async () => {
    hc?.close();
    // a core started with anything but the isolated env could be the user's: only this test's is stopped
    let stopped = 0;
    if (bin && env) stopped = await Bun.spawn([bin, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" }).exited;
    // hc's core and holder are detached daemons, not children: their exit has no event to await
    const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + WAIT_MS;
    while (pids.some(running) && Date.now() < deadline) await Bun.sleep(25);
    const alive = pids.filter(running);
    for (const pid of alive) process.kill(pid, "SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
    expect({ stopped, killed: alive }).toEqual({ stopped: 0, killed: [] });
  }, TEST_MS);

  it("publishes the schema hc-api.generated.ts was made from", async () => {
    const proc = Bun.spawn([bin!, "schema"], { env: env!, stdout: "pipe", stderr: "ignore" });
    const schema: unknown = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    // a different hc: refresh with OVIS_HC_BIN=<it> bun run generate:types --refresh-hc
    expect(schema).toEqual(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "scripts", "hc-schema.json"), "utf8")));
  }, TEST_MS);

  it("speaks generation 1 in framed mode", async () => {
    const hello = await hc.hello();
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(hello.core.id).not.toBe("");
  }, TEST_MS);

  it("attaches, resizes, types, and hears the program's OSC 7501 status as events", async () => {
    const events: { type: string; terminal?: string; data?: Record<string, unknown> }[] = [];
    let pending = "";
    const subscription = await hc.open("events.subscribe", {}, {
      onData: (payload) => {
        pending += new TextDecoder().decode(payload);
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          const message = JSON.parse(line) as { method: string; params: { type: string; terminal?: string; data?: Record<string, unknown> } };
          if (message.method === "event") events.push(message.params);
        }
        wake();
      },
      onClose: () => {},
    });
    const report = (state: string) => `printf '\\033]7501;state=${state}:app=ovis-test\\033\\\\'`;
    const script = `stty -echo; while IFS= read -r line; do case "$line" in w) ${report("working")};; d) ${report("done")};; esac; echo "got:$line"; done`;
    const record = await hc.call("terminal.run", { argv: ["bash", "-c", script] });

    let screen = "";
    const attach = await hc.open("terminal.attach", { terminal: record.address, cols: 80, rows: 24 }, {
      onData: (payload) => { screen += new TextDecoder().decode(payload); wake(); },
      onClose: () => {},
    });
    await until("first paint", () => screen.length > 0);
    const attached = await hc.call("terminal.get", { terminal: record.address });
    expect([attached.cols, attached.rows]).toEqual([80, 24]);

    attach.channel.resize(100, 30);
    await until("resize", () => events.some((event) => event.type === "size" && event.terminal === record.address && event.data?.["cols"] === 100));
    const resized = await hc.call("terminal.get", { terminal: record.address });
    expect([resized.cols, resized.rows]).toEqual([100, 30]);

    const stateOf = (event: (typeof events)[number]) => (event.data?.["status"] as { state?: string } | null | undefined)?.state;
    attach.channel.write("w\r");
    await until("working", () => events.some((event) => event.type === "status" && event.terminal === record.address && stateOf(event) === "working"));
    attach.channel.write("d\r");
    await until("done", () => events.some((event) => event.type === "status" && event.terminal === record.address && stateOf(event) === "done"));
    await until("echo", () => screen.includes("got:d"));

    await attach.channel.close();
    await hc.call("terminal.kill", { terminal: record.address });
    await until("finished", () => events.some((event) => event.type === "finished" && event.terminal === record.address));
    await hc.call("terminal.rm", { terminal: record.address });
    await until("removed", () => events.some((event) => event.type === "removed" && event.terminal === record.address));
    await subscription.channel.close();
  }, TEST_MS);

  it("gets a reply the viewer's terminal made itself to the program, whether or not hc confirms automatic input", async () => {
    const hello = await hc.hello();
    const record = await hc.call("terminal.run", { argv: ["bash", "-c", "stty -echo; IFS= read -r line; echo \"got:$line\"; exit 3"] });
    let screen = "";
    const exit = Promise.withResolvers<number | null>();
    const session = new CoreAttachSession({
      hc,
      terminal: record.address,
      cols: 80,
      rows: 24,
      onData: (data) => { screen += data; wake(); },
      onExit: (code) => exit.resolve(code),
    });
    await until("first paint", () => screen.length > 0);
    // a core without the feature must get it as DATA: AUTOMATIC_INPUT it does not know would be dropped
    session.write("auto\r", true);
    expect(await exit.promise).toBe(3);
    expect(screen).toContain("got:auto");
    // what the pinned core says, for whoever raises the pin: hc 0.1.14 to 0.1.17 do not name the feature
    console.info(`hc ${hello.version} automatic_input: ${hello.features.includes("automatic_input")}`);
    await hc.call("terminal.rm", { terminal: record.address });
  }, TEST_MS);

  it("streams a terminal through CoreAttachSession: typing, a resize, and the program's exit code", async () => {
    const record = await hc.call("terminal.run", { argv: ["bash", "-c", "stty -echo; IFS= read -r line; echo \"got:$line\"; exit 7"] });
    let sizes = "";
    const events = await hc.open("events.subscribe", { terminal: record.address }, {
      onData: (payload) => { sizes += new TextDecoder().decode(payload); wake(); },
      onClose: () => {},
    });
    let screen = "";
    const exit = Promise.withResolvers<number | null>();
    const session = new CoreAttachSession({
      hc,
      terminal: record.address,
      cols: 80,
      rows: 24,
      onData: (data) => { screen += data; wake(); },
      onExit: (code) => exit.resolve(code),
    });
    await until("first paint", () => screen.length > 0);
    session.resize(90, 20);
    await until("resize", () => sizes.includes('"cols":90'));
    const sized = await hc.call("terminal.get", { terminal: record.address });
    expect([sized.cols, sized.rows]).toEqual([90, 20]);
    session.write("hi\r");
    expect(await exit.promise).toBe(7);
    expect(screen).toContain("got:hi");
    events.channel.close();
    await hc.call("terminal.rm", { terminal: record.address });
  }, TEST_MS);
  it("places an hc run child after its parent's tab and carries its OSC 7501 kind, message and progress", async () => {
    const events: { type: string; terminal?: string; data?: Record<string, unknown> }[] = [];
    let pending = "";
    const subscription = await hc.open("events.subscribe", {}, {
      onData: (payload) => {
        pending += new TextDecoder().decode(payload);
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          const message = JSON.parse(pending.slice(0, at)) as { method: string; params: { type: string; terminal?: string; data?: Record<string, unknown> } };
          pending = pending.slice(at + 1);
          if (message.method === "event") events.push(message.params);
        }
        wake();
      },
      onClose: () => {},
    });
    // the spec's msg is base64; hc keeps it decoded
    const msg = Buffer.from("Allow bash: rm -rf build?").toString("base64");
    const child = `printf '\\033]7501;state=blocked:app=codex:kind=permission:progress=60:msg=${msg}\\033\\\\'; sleep 30`;
    // started from inside the parent, as an agent starts a helper: hc names the parent from HC_TERMINAL_ID
    const parent = await hc.call("terminal.run", {
      argv: ["bash", "-c", '"$OVIS_TEST_HC" run --bg --name helper -- bash -c "$OVIS_TEST_CHILD"; sleep 30'],
      env: { OVIS_TEST_HC: bin!, OVIS_TEST_CHILD: child },
      labels: { "herdr.space": "s-live", "herdr.tab": "t-live" },
    });
    const statusOf = (event: (typeof events)[number]) => event.data?.["status"] as { state?: string; kind?: string } | null | undefined;
    await until("the child's blocked report", () => events.some((event) => event.type === "status" && event.terminal !== parent.address && statusOf(event)?.kind === "permission"));
    const childAddress = events.find((event) => event.type === "status" && statusOf(event)?.kind === "permission")!.terminal!;

    const list = await hc.call("terminal.list", {});
    const snapshot = buildSnapshot(list.terminals, null, "live");
    expect(snapshot.tabs.filter((tab) => tab.workspace_id === "s-live").map((tab) => tab.tab_id)).toEqual(["t-live", `s-live:${childAddress}`]);
    expect(snapshot.panes.find((pane) => pane.pane_id === childAddress)).toMatchObject({
      workspace_id: "s-live", parent_pane_id: parent.address, agent_status: "blocked", agent: "codex",
      agent_kind: "permission", agent_message: "Allow bash: rm -rf build?", agent_progress: 60,
    } satisfies Partial<HerdrPane>);

    for (const address of [childAddress, parent.address]) {
      await hc.call("terminal.kill", { terminal: address });
      await until(`${address} finished`, () => events.some((event) => event.type === "finished" && event.terminal === address));
      await hc.call("terminal.rm", { terminal: address });
    }
    await subscription.channel.close();
  }, TEST_MS);

  it("renames and moves Ovis's own workspaces and tabs in labels on a core no Herdr app arranges, and splits none", async () => {
    const socket = join(dir, "herdr.sock");
    const adapter = await startHerdrCoreAdapter(hc, socket);
    // the core is this test's own and stops in afterAll: a failure here leaves nothing for another test
    try {
      expect((await ping(socket)).layout).toEqual({ rename: true, split: false, move: true });
      const api = await workspaceCreate({ cwd: dir, label: "api" }, socket);
      const web = await workspaceCreate({ cwd: dir, label: "web" }, socket);

      await workspaceRename(api.workspace.workspace_id, "backend", socket);
      await tabRename(api.tab.tab_id, "server", socket);
      const split = await herdrRpc("pane.split", { target_pane_id: api.root_pane.pane_id, direction: "right" }, socket).then(() => "split", (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
      expect(split).toBe("unsupported");

      let snapshot = await sessionSnapshot(socket);
      expect(snapshot.workspaces.find((workspace) => workspace.workspace_id === api.workspace.workspace_id)?.label).toBe("backend");
      expect(snapshot.tabs.find((tab) => tab.tab_id === api.tab.tab_id)?.label).toBe("server");
      expect(snapshot.panes.filter((pane) => pane.tab_id === api.tab.tab_id).map((pane) => pane.pane_id)).toEqual([api.root_pane.pane_id]);

      const moved = await paneMoveToNewTab(web.root_pane.pane_id, api.workspace.workspace_id, "moved", socket);
      expect(moved).toMatchObject({ pane: { pane_id: web.root_pane.pane_id, workspace_id: api.workspace.workspace_id }, closed_tab_id: web.tab.tab_id, closed_workspace_id: web.workspace.workspace_id });
      snapshot = await sessionSnapshot(socket);
      expect(snapshot.workspaces.some((workspace) => workspace.workspace_id === web.workspace.workspace_id)).toBe(false);
      expect(snapshot.tabs.filter((tab) => tab.workspace_id === api.workspace.workspace_id).map((tab) => tab.label)).toEqual(["server", "moved"]);
      // the moved pane takes its new workspace's name, so it never renames it
      expect(snapshot.workspaces.find((workspace) => workspace.workspace_id === api.workspace.workspace_id)?.label).toBe("backend");
      await workspaceClose(api.workspace.workspace_id, socket);
    } finally {
      adapter.stop();
    }
  }, TEST_MS);
});
