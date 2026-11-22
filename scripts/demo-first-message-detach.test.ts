import assert from "node:assert/strict";
import { it } from "bun:test";

it("the demo holds a first message when the page that asked for it leaves the pane, as the bridge does, and never types it at the agent's rest", async () => {
  const saved = new Map(["setTimeout", "clearTimeout", "window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const opened: any[] = [];
  try {
    const timers = new Map<number, { run: () => void; ms: number }>();
    let timerId = 1;
    globalThis.setTimeout = ((run: () => void, ms = 0) => { const id = timerId++; timers.set(id, { run, ms }); return id; }) as any;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    // its own module instance: the transport binds the window it finds, and another file's import would reuse this one
    const transport = "../site/demo/transport.ts?first-message-detach";
    await import(transport);
    const demo = (globalThis as any).window;
    const runTimer = (ms: number) => {
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms) ?? [];
      assert.ok(timer, `a ${ms} ms timer was scheduled`);
      timers.delete(id!);
      timer!.run();
    };
    const socket = new demo.WebSocket("ws://demo.test/ws");
    opened.push(socket);
    const frames: any[] = [];
    socket.addEventListener("message", (event: MessageEvent) => frames.push(JSON.parse(String(event.data))));
    runTimer(20);
    const connection = frames.find((frame) => frame.type === "snapshot").connection;
    const workspace = (await (await demo.fetch("/api/session")).json()).snapshot.workspaces[0].workspace_id;
    const made = await (await demo.fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace, agent: { kind: "omp" }, first_message: "Plan the config file", first_message_connection: connection }) })).json();
    const pane = made.pane_id;
    socket.send(JSON.stringify({ type: "attach", pane_id: pane }));
    runTimer(0);
    const latest = () => frames.findLast((frame) => frame.type === "pending-messages" && frame.pane_id === pane);
    assert.equal(latest().messages[0].state, "queued");
    socket.send(JSON.stringify({ type: "detach", pane_id: pane }));
    socket.send(JSON.stringify({ type: "attach", pane_id: pane }));
    runTimer(0);
    assert.deepEqual({ state: latest().messages[0].state, code: latest().messages[0].error?.code }, { state: "held", code: "first_message_unattended" });
    runTimer(1500);
    assert.equal(frames.some((frame) => frame.type === "pending-messages" && frame.pane_id === pane && frame.removed?.some((entry: any) => entry.outcome === "sent")), false);
    assert.equal(latest().messages[0].state, "held");
  } finally {
    for (const socket of opened) socket.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
