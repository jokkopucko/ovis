/** Deterministic CLIProxyAPI v8 wire fixture; never reads credentials or calls a provider. */
import { isJsonObject } from "./http.ts";

export function startFakeCLIProxy(key = "test-management-key") {
  let acceptedKey = key;
  let down = false;
  const files = [
    { name: "claude-a.json", provider: "claude", email: "claude-a@example.test", status: "ready", disabled: false, unavailable: false, auth_index: "a", id_token: null },
    { name: "codex-b.json", provider: "codex", email: "codex-b@example.test", status: "ready", disabled: false, unavailable: false, auth_index: "b", id_token: { chatgpt_account_id: "workspace-b" } },
  ];
  const sessions = new Map<string, { provider: string; status: string }>();
  /** what the provider answers an account's read, by its auth_index, in place of its usage */
  const answers = new Map<string, { status_code: number; body: string }>();
  const calls: { path: string; body: unknown; authorization: string | null }[] = [];
  let sequence = 0;
  let held: { arrive: () => void; gate: Promise<void> } | null = null;
  const holdCredentials = () => {
    const arrived = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    held = { arrive: arrived.resolve, gate: gate.promise };
    return { arrived: arrived.promise, release: gate.resolve };
  };
  let heldRead: { arrive: () => void; gate: Promise<void> } | null = null;
  const holdRead = () => {
    const arrived = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    heldRead = { arrive: arrived.resolve, gate: gate.promise };
    return { arrived: arrived.promise, release: gate.resolve };
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace("/v8/management", "");
    const body: unknown = request.method === "POST" ? await request.json() : null;
    calls.push({ path, body, authorization: request.headers.get("authorization") });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (path === "/authorize") return new Response(`<h1>Fixture sign-in</h1><a href="/complete?state=${url.searchParams.get("state")}">Complete sign-in</a>`, { headers: { "content-type": "text/html" } });
    const finish = (state: string) => {
      const pending = sessions.get(state);
      if (pending && pending.status !== "ok") {
        pending.status = "ok";
        files.push({ name: `${state}.json`, provider: pending.provider, email: `${state}@example.test`, status: "ready", disabled: false, unavailable: false, auth_index: state, id_token: null });
      }
    };
    if (path === "/complete") { finish(url.searchParams.get("state") ?? ""); return new Response("Signed in. Return to Settings."); }
    if (down) return json({ error: "unavailable" }, 503);
    if (request.headers.get("authorization") !== `Bearer ${acceptedKey}`) return json({ error: `invalid management key ${acceptedKey}` }, 401);
    if (path === "/credentials") {
      const hold = held;
      held = null;
      if (hold) { hold.arrive(); await hold.gate; }
      return json({ files });
    }
    if (path === "/requests/api-call") {
      const hold = heldRead;
      heldRead = null;
      if (hold) { hold.arrive(); await hold.gate; }
      if (!isJsonObject(body) || typeof body["url"] !== "string" || !isJsonObject(body["header"])) return json({ error: "bad request" }, 400);
      if (body["auth_index"] === "b" && body["header"]["chatgpt-account-id"] !== "workspace-b") return json({ status_code: 400, header: {}, body: "{}" });
      const answer = answers.get(String(body["auth_index"]));
      if (answer) return json({ ...answer, header: {} });
      return json({ status_code: 200, header: {}, body: JSON.stringify(body["url"].includes("anthropic") ? {
        five_hour: { utilization: 25, resets_at: "2026-10-17T12:00:00Z" }, seven_day: { utilization: 55, resets_at: "2026-10-20T12:00:00Z" },
      } : { plan_type: "pro", rate_limit: { primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 1792238400 } } }) });
    }
    if (path === "/oauth/auth-url") {
      const state = `login-${++sequence}`;
      sessions.set(state, { provider: url.searchParams.get("provider") ?? "", status: "wait" });
      return json({ status: "ok", url: `${server.url.origin}/authorize?state=${state}`, state });
    }
    if (path === "/oauth/status") return json({ status: sessions.get(url.searchParams.get("state") ?? "")?.status ?? "error" });
    if (path === "/oauth/session") { sessions.delete(url.searchParams.get("state") ?? ""); return json({ status: "ok", cancelled: true }); }
    if (path === "/oauth/callback") {
      if (!isJsonObject(body) || typeof body["state"] !== "string") return json({ error: "bad request" }, 400);
      finish(body["state"]); return json({ status: "ok" });
    }
    return json({ error: "not found" }, 404);
  } });
  return { server, calls, files, sessions, answers, holdCredentials, holdRead, setKey: (value: string) => { acceptedKey = value; }, setDown: (value: boolean) => { down = value; } };
}
