import assert from "node:assert/strict";
import { it } from "bun:test";

it("the demo's Send now reads the pane at rest before it sends a first message: ok without a refusal at rest, refused unsent while it works", async () => {
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
    const transport = "../site/demo/transport.ts?first-message";
    await import(transport);
    const demo = (globalThis as any).window;
    const runTimer = (ms: number) => {
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms) ?? [];
      assert.ok(timer, `a ${ms} ms timer was scheduled`);
      timers.delete(id!);
      timer!.run();
    };
    const workspace = (await (await demo.fetch("/api/session")).json()).snapshot.workspaces[0].workspace_id;
    const made = await (await demo.fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace, agent: { kind: "omp" }, first_message: "Plan the config file" }) })).json();
    const pane = made.pane_id;
    const socket = new demo.WebSocket("ws://demo.test/ws");
    opened.push(socket);
    const frames: any[] = [];
    socket.addEventListener("message", (event: MessageEvent) => frames.push(JSON.parse(String(event.data))));
    runTimer(20);
    socket.send(JSON.stringify({ type: "attach", pane_id: pane }));
    const sendNow = (id: number) => {
      socket.send(JSON.stringify({ type: "pending-action", id, pane_id: pane, pending_id: made.first_message.id, action: "steer" }));
      return frames.findLast((frame) => frame.type === "pending-result" && frame.id === id);
    };
    const sent = () => frames.some((frame) => frame.type === "pending-messages" && frame.pane_id === pane && frame.removed?.some((entry: any) => entry.id === made.first_message.id && entry.outcome === "sent"));
    const working = sendNow(1);
    assert.deepEqual({ ok: working.ok, code: working.code }, { ok: false, code: "agent_blocked" });
    assert.equal(sent(), false, "not sent while the agent works");
    runTimer(1500);
    const resting = sendNow(2);
    assert.equal(resting.ok, true);
    assert.equal(resting.code, undefined, "no refusal beside a send");
    assert.equal(sent(), true);
  } finally {
    for (const socket of opened) socket.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
