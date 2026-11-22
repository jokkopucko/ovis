interface Recorded { url: string; body: Record<string, unknown> }
export interface QaWindow {
  qaRequests: Recorded[];
  qaHold: boolean;
  qaRelease: () => void;
  qaSubmits: string[];
  qaDrop: () => void;
  qaSockets: WebSocket[];
  qaOldBridge: boolean;
  qaSkillsBusy: Record<string, number>;
  qaSkillsBusyServed: number;
  qaHoldAgentReady: boolean;
  qaReleaseAgent: () => void;
}

export const record = `<script>(() => {
  const demoFetch = window.fetch;
  window.qaRequests = [];
  window.qaHold = false;
  window.qaOldBridge = false;
  window.qaSkillsBusy = {};
  window.qaSkillsBusyServed = 0;
  let release = null;
  let ready = null;
  window.qaRelease = () => { if (release) release(); release = null; };
  window.qaReleaseAgent = () => {
    if (!ready) throw new Error("the demo did not schedule the created agent's readiness");
    const finish = ready;
    ready = null;
    finish();
  };
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const busyAgent = url.includes("/agent/commands") ? new URL(url, location.href).searchParams.get("agent") : null;
    if (busyAgent && (window.qaSkillsBusy[busyAgent] ?? 0) > 0) {
      window.qaSkillsBusy[busyAgent] -= 1;
      window.qaSkillsBusyServed += 1;
      return new Response(JSON.stringify({ error: { code: "file_busy", message: "the skill folders did not answer in time" } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } });
    }
    if ((init?.method ?? "GET") === "POST" && (url.includes("/api/tab/create") || url.includes("/api/workspace/create"))) {
      const body = JSON.parse(String(init?.body ?? "null"));
      window.qaRequests.push({ url, body });
      if (window.qaHold) await new Promise((resolve) => { release = resolve; });
      // Only hold the demo's ready timer for this launch. The socket's reconnect timers still run.
      if (window.qaHoldAgentReady && typeof body.first_message === "string") {
        window.qaHoldAgentReady = false;
        const startTimer = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay !== 1500) return startTimer(callback, delay, ...args);
          window.setTimeout = startTimer;
          ready = () => callback(...args);
          return 0;
        };
        try { return await demoFetch(input, init); }
        finally { window.setTimeout = startTimer; }
      }
      // A bridge from before first_message starts the agent but answers without the field.
      if (window.qaOldBridge) {
        const answer = await demoFetch(input, init);
        const { first_message: _, ...made } = await answer.json();
        return new Response(JSON.stringify(made), { status: answer.status, headers: { "content-type": "application/json" } });
      }
    }
    return demoFetch(input, init);
  };
  const Demo = window.WebSocket;
  window.qaSubmits = [];
  window.qaSockets = [];
  window.qaDrop = () => { for (const socket of window.qaSockets.splice(0)) socket.close(); };
  const Counted = function (url, protocols) {
    const socket = new Demo(url, protocols);
    window.qaSockets.push(socket);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (typeof data === "string") { const frame = JSON.parse(data); if (frame.type === "submit") window.qaSubmits.push(frame.text); }
      send(data);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Counted, name, { value: Demo[name] });
  window.WebSocket = Counted;
})();</script>`;
