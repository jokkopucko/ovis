import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemoApp } from "./demo-build.ts";

export const MACHINE_CONTROLS_FIXTURE_SCRIPT = String.raw`(() => {
  const demoFetch = window.fetch.bind(window);
  const DemoEventSource = window.EventSource;
  const sources = new Set();
  const observers = [];
  const calls = { mutations: [], deleteAttempts: 0, deleteCount: 0, frames: 0, sessionReads: 0 };
  let demoMachines = [];
  let remote = {
    id: "sidebar-fixture", name: "Demo remote PC", kind: "ssh",
    target: { destination: "fixture.invalid" }, enabled: true,
    state: "disconnected", error: null, snapshot: null,
  };
  const managed = {
    id: "sidebar-managed-fixture", herdr_profile_id: "fixture-profile",
    name: "Managed demo PC", kind: "ssh", target: { destination: "fixture.invalid" },
    enabled: true, state: "disconnected", error: null, snapshot: null,
  };
  let remoteRegistered = true;
  let armedGate = null;
  let waitingGate = null;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
  const error = (code, message, status) => json({ error: { code, message } }, status);
  const roster = () => [
    ...structuredClone(demoMachines),
    ...(remoteRegistered ? [structuredClone(remote)] : []),
    structuredClone(managed),
  ];
  const rosterEvent = () => ({ type: "machines", machines: roster() });
  function send(source, payload) {
    const event = new MessageEvent("message", { data: JSON.stringify(payload) });
    source.onmessage?.call(source, event);
    source.dispatchEvent(event);
  }
  function broadcast() {
    const payload = rosterEvent();
    for (const source of sources) send(source, payload);
  }
  async function bodyOf(input, init) {
    try {
      if (init?.body !== undefined) return JSON.parse(String(init.body));
      if (input instanceof Request) return await input.clone().json();
    } catch { /* malformed mutation fails closed below */ }
    return null;
  }
  function observe() {
    const frames = [];
    const source = new window.EventSource("/api/machines/events");
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "machines") frames.push(payload.machines);
      } catch { /* the demo can also send other event types */ }
    };
    observers.push({ source, frames });
    return observers.length - 1;
  }
  function releaseMutation(success) {
    const gate = waitingGate ?? armedGate;
    if (!gate) throw new Error("no mutation is waiting for release");
    if (waitingGate === gate) waitingGate = null;
    if (armedGate === gate) armedGate = null;
    gate.resolve(success);
  }

  window.machineControlsFixture = {
    calls,
    get roster() { return roster(); },
    holdNextMutation() {
      if (armedGate) throw new Error("a mutation gate is already armed");
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      armedGate = { promise, resolve };
    },
    releaseMutation,
    observe,
    // the remote PC as the server would tell it next (an SSH PC it keeps failing to reach, say)
    setRemote(patch) { Object.assign(remote, patch); broadcast(); },
    observerRoster(index) { return observers[index]?.frames.at(-1) ?? null; },
  };

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return demoFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/machines" && method === "GET") {
      const response = await demoFetch(input, init);
      if (!response.ok) return response;
      const payload = await response.json();
      demoMachines = payload.machines;
      return json({ ...payload, machines: roster() });
    }

    // a read of the remote PC: what Check again asks; the server answers a PC it has no connection to so
    if (url.pathname === "/api/machines/sidebar-fixture/session" && method === "GET") {
      calls.sessionReads++;
      return error("machine_offline", "This PC is disconnected", 503);
    }

    const machinePath = url.pathname.match(/^\/api\/machines(?:\/([^/]+)(?:\/.*)?)?$/);
    if (machinePath && method !== "GET" && method !== "HEAD") {
      const id = machinePath[1] ?? "";
      const isRemote = id === "sidebar-fixture" && remoteRegistered && url.pathname === "/api/machines/sidebar-fixture";
      // Only the inert remote PC can be renamed, toggled or removed here; every other mutation fails
      // closed so none reaches the demo transport or the network. The server's refusals (a
      // herdr-managed PC, an unknown one, a bad body) are the server's own tests' to check.
      if (!isRemote || (method !== "PATCH" && method !== "DELETE")) return error("not_found", "Unknown fixture PC mutation.", 404);

      const record = { id, method, path: url.pathname, body: await bodyOf(input, init) };
      calls.mutations.push(record);
      if (method === "DELETE") calls.deleteAttempts++;
      const gate = armedGate;
      if (gate) {
        armedGate = null;
        waitingGate = gate;
        const succeeded = await gate.promise;
        if (waitingGate === gate) waitingGate = null;
        if (!succeeded) return error("fixture_failure", "Fixture mutation rejected.", 500);
      }

      if (method === "PATCH") {
        const body = record.body ?? {};
        if (typeof body.name === "string") remote.name = body.name;
        if (typeof body.enabled === "boolean") remote.enabled = body.enabled;
        broadcast();
        return json({ ok: true });
      }

      remoteRegistered = false;
      calls.deleteCount++;
      broadcast();
      return json({ ok: true });
    }

    // Every other API read is answered by the demo transport, never by the network.
    return demoFetch(input, init);
  };

  window.EventSource = class FixtureEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url, init) {
      super();
      this.inner = new DemoEventSource(url, init);
      this.url = this.inner.url;
      sources.add(this);
      this.inner.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { send(this, event); return; }
        if (payload.type === "machines") {
          demoMachines = payload.machines.filter((machine) => machine.id !== "sidebar-fixture" && machine.id !== managed.id);
          payload = rosterEvent();
          calls.frames++;
        }
        send(this, payload);
      };
      this.inner.onopen = (event) => { this.onopen?.call(this, event); this.dispatchEvent(event); };
      this.inner.onerror = (event) => { this.onerror?.call(this, event); this.dispatchEvent(event); };
    }
    get readyState() { return this.inner.readyState; }
    close() { sources.delete(this); this.inner.close(); }
    onmessage = null;
    onopen = null;
    onerror = null;
  };
})();`;

export async function prepareMachineControlsDemo(app: string): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  if (!/<script type="module"/.test(html)) throw new Error("the demo client index has no module script");
  writeFileSync(join(app, "machine-controls-fixture.js"), MACHINE_CONTROLS_FIXTURE_SCRIPT);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./machine-controls-fixture.js"></script>\n    <script type="module"'));
}
