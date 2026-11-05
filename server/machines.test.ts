import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describeProgress } from "../src/lib/bridgeProgress.ts";
import type { SetupJob } from "../shared/machines.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";
import { paneNotificationTag } from "../shared/notify-policy.ts";
import { BRIDGE_PROTOCOL, machinePath, paneStorageId, REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { canSendSecret, sameOrigin, shellQuote, validateTarget } from "./machine-security.ts";
import { handleMachineRequest, MACHINE_PROXY_PATH } from "./machine-api.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { createServer } from "./index.ts";
import { MachineActionRequired, MachineManager } from "./machines.ts";
import { detectHost, psQuote, UNSUPPORTED_HOST, windowsBridgeFiles, windowsHost } from "./remote-host.ts";
import { decodeClixml, SshConnection } from "./ssh.ts";
import { terminalAttachSupported } from "./herdr/client.ts";
import { attachableIdentity, isRealNode, sidecarAvailable } from "./pty/sidecar.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import { recentSshOutput } from "./ssh.ts";
import { RemoteResponseInvalid, RemoteResponseTooLarge } from "./remote-json.ts";

const MiB = 1024 * 1024;
/**
 * `value` as JSON of exactly `total` bytes (whitespace after its first byte), served lazily so a
 * reader that stops early leaves most of it unsent; `cancelled` settles when the reader gives up.
 */
function padded(value: unknown, total: number): { stream: ReadableStream<Uint8Array>; cancelled: Promise<void> } {
  const json = JSON.stringify(value);
  const space = new Uint8Array(64 * 1024).fill(0x20);
  const cancelled = Promise.withResolvers<void>();
  let left = total - json.length;
  let opened = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!opened) { opened = true; controller.enqueue(new TextEncoder().encode(json.slice(0, 1))); return; }
      if (left > 0) { const size = Math.min(left, space.length); left -= size; controller.enqueue(space.slice(0, size)); return; }
      controller.enqueue(new TextEncoder().encode(json.slice(1)));
      controller.close();
    },
    cancel() { cancelled.resolve(); },
  });
  return { stream, cancelled: cancelled.promise };
}
/** `event`, or a failure once it has not come within a few seconds */
async function within(event: Promise<void>, what = "the remote answer was not cancelled"): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([event, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), 5000); })]); }
  finally { clearTimeout(timer); }
}

describe("machine settings recovery", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("logs the cause when settings are unreadable", () => {
    // Given a settings file this user cannot read.
    const dir = mkdtempSync(join(tmpdir(), "herdr-machine-settings-"));
    const path = join(dir, "machine-settings.json");
    writeFileSync(path, "{}", { mode: 0o000 });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      // When the manager loads its settings.
      const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); });
      manager.stop();
      // Then only the filesystem code accompanies the recovery diagnostic.
      expect(errors.mock.calls).toEqual([[expect.any(String), "EACCES"]]);
    } finally {
      errors.mockRestore();
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs damaged settings but stays quiet for valid or missing settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-machine-settings-"));
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    const createManager = () => new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); });
    try {
      const valid = createManager();
      valid.stop();
      expect(errors).toEqual([]);

      const secret = "GATE_SECRET_1731";
      writeFileSync(join(dir, "machine-settings.json"), `{"token":${secret}}`);
      const damaged = createManager();
      damaged.stop();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.[1]).toBe("not valid JSON");
      expect(errors.flat().map(String).join(" ")).not.toContain(secret);

      errors.length = 0;
      writeFileSync(join(dir, "machine-settings.json"), JSON.stringify({ auto_update_bridges: true }));
      const repaired = createManager();
      repaired.stop();
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("independently managed bridge updates", () => {
  it("requires the owning app's update controls before installing a remote bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-bridge-owner-"));
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); });
    const socket = "/home/u/.config/herdr/herdr.sock";
    const descriptor = { pid: process.pid, port: 7317, token: "a".repeat(64), socket_path: socket, bridge_protocol: 1, bundle_version: "older", managed_remote: false };
    const commands: string[] = [];
    // that PC's own Ovis answers through the tunnel as a server its updater did not start
    const tunnels: ReturnType<typeof Bun.serve>[] = [];
    const asked: string[] = [];
    let bridgeReady = false;
    const ssh = { run: async (script: string) => {
      commands.push(script);
      if (script.includes("uname")) return `Linux\nx86_64\n/home/u\n/home/u/.config\n/usr/bin/herdr\nbundle-older\n${JSON.stringify(descriptor)}\n`;
      if (script.includes("socket=")) return socket;
      if (script.includes("--version")) return "herdr 0.9.3";
      if (script.includes("kill -0")) return "live";
      throw new Error("Unexpected remote mutation");
    }, forward: async (local: number) => {
      tunnels.push(Bun.serve({ hostname: "127.0.0.1", port: local, fetch(request) {
        asked.push(`${request.method} ${new URL(request.url).pathname}`);
        if (new URL(request.url).pathname === "/api/updates") return Response.json({ managed: false, phase: "idle", available: false, blocked_reason: "Start with bun run start or the herdr plugin to enable updates." });
        if (new URL(request.url).pathname === "/api/bridge" && bridgeReady) return Response.json({ ...descriptor, socket_id: "fixture:1", herdr: { version: "0.9.3", protocol: 22 } });
        return new Response("not found", { status: 404 });
      } }));
    } } as unknown as SshConnection;
    const prepare = (manager as unknown as { prepare(runtime: unknown, job?: unknown): Promise<void> }).prepare.bind(manager);
    const runtime = { generation: 0, ssh, machine: { target: { destination: "pc" } } };
    try {
      await expect(prepare(runtime)).rejects.toMatchObject({ action: "setup", message: expect.stringContaining("does not update itself") });
      await expect(prepare(runtime, { update: true, auto: true, public: { installations: [] }, abort: new AbortController() })).rejects.toMatchObject({ action: "setup" });
      // it was only asked how it updates, never to install anything
      expect(asked.every((request) => request.startsWith("GET "))).toBe(true);
      descriptor.managed_remote = true;
      await expect(prepare(runtime)).rejects.toThrow("Bridge verification failed (404)");
      bridgeReady = true;
      await expect(prepare(runtime)).rejects.toMatchObject({ action: "update_bridge" });
      expect(asked.every((request) => request.startsWith("GET "))).toBe(true);
      expect(commands.every(script => script.includes("uname") || script.includes("socket=") || script.includes("--version") || script.includes("kill -0"))).toBe(true);
    } finally { manager.stop(); for (const tunnel of tunnels) tunnel.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("machine boundaries", () => {
  for (const older of [false, true]) it(`strips command previews for observers while preserving ${older ? "older" : "current"} bridge responses`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-outcome-proxy-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); });
    const answer: PanePromptResponse = { prompt: null, ...(older ? {} : { outcomes: [{
      id: "send-1", pane_id: "pane-1", text: "/context", state: "accepted" as const, evidence: [],
      preview: "fixture-preview", result_text: "fixture-result", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z",
    }] }) };
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(answer) });
    const endpoint = spyOn(manager, "endpoint").mockReturnValue({ url: `http://127.0.0.1:${bridge.port}`, token: "fixture" });
    try {
      const request = new Request("http://localhost/api/machines/fixture/pane/prompt?pane_id=pane-1");
      const watched = await (await handleMachineRequest(request, manager, undefined, undefined, true)).json() as PanePromptResponse;
      expect(watched.prompt).toBeNull();
      if (older) expect(watched.outcomes).toBeUndefined();
      else {
        expect(watched.outcomes?.[0]?.state).toBe("accepted");
        expect(watched.outcomes?.[0]).not.toHaveProperty("preview");
        expect(watched.outcomes?.[0]).not.toHaveProperty("result_text");
        const owner = await (await handleMachineRequest(request, manager)).json() as PanePromptResponse;
        expect(owner.outcomes?.[0]?.preview).toBe(answer.outcomes?.[0]?.preview);
        expect(owner.outcomes?.[0]?.result_text).toBe(answer.outcomes?.[0]?.result_text);
      }
    } finally { endpoint.mockRestore(); bridge.stop(true); manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("redacts watched prompt after bounded read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-watched-prompt-cap-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); });
    const answer = {
      prompt: { id: "prompt-1", agent: "claude", kind: "plan", title: "Plan", question: "Proceed?", body: "fixture-plan-text", options: [], multi_select: false, custom_option_index: null, plan_file: "/home/u/.claude/plans/fixture-plan.md" },
      outcomes: [{ id: "send-1", pane_id: "pane-1", text: "/context", state: "accepted", evidence: [], preview: "fixture-preview", result_text: "fixture-result", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" }],
    } as PanePromptResponse;
    let serve = () => new Response("{}");
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => serve() });
    const url = `http://127.0.0.1:${bridge.port}`;
    const endpoint = spyOn(manager, "endpoint").mockReturnValue({ url, token: "fixture-token" });
    let tracked = 0;
    const track = spyOn(manager, "trackTerminal").mockImplementation(() => { tracked++; return () => { tracked--; }; });
    const logged: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    const watch = () => handleMachineRequest(new Request("http://localhost/api/machines/fixture/pane/prompt?pane_id=pane-1"), manager, undefined, undefined, true);
    try {
      // exactly at its 1 MiB the answer is still parsed, and loses the plan file and the previews
      serve = () => new Response(padded(answer, MiB).stream);
      const kept = await watch();
      expect(kept.status).toBe(200);
      const card = await kept.json() as PanePromptResponse;
      expect(card.prompt).toMatchObject({ question: "Proceed?", body: null });
      expect(card.prompt).not.toHaveProperty("plan_file");
      expect(card.outcomes?.[0]).not.toHaveProperty("preview");
      expect(card.outcomes?.[0]).not.toHaveProperty("result_text");
      // one byte past it, and the answer is refused rather than passed on unredacted
      const over = padded(answer, MiB + 32 * MiB);
      serve = () => new Response(over.stream);
      const refused = await watch();
      expect(refused.status).toBe(502);
      const tooLarge = await refused.text();
      expect(JSON.parse(tooLarge).error.code).toBe("remote_response_too_large");
      await within(over.cancelled);
      // an answer that is not JSON cannot be redacted, so none of it is passed on
      serve = () => new Response(`{"prompt":{"plan_file":"fixture-plan-secret","body":"fixture-plan-text"`);
      const malformed = await watch();
      expect(malformed.status).toBe(502);
      const invalid = await malformed.text();
      expect(JSON.parse(invalid).error.code).toBe("remote_response_invalid");
      for (const text of [tooLarge, invalid, logged.join("\n")]) {
        expect(text).not.toContain("fixture-plan");
        expect(text).not.toContain("fixture-token");
        expect(text).not.toContain(url);
      }
      expect(tracked).toBe(0);
    } finally { error.mockRestore(); track.mockRestore(); endpoint.mockRestore(); bridge.stop(true); manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("caps a buffered proxy answer and recovers on the next one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-proxy-cap-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); });
    let hits = 0;
    let serve = () => Response.json({ ok: true });
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return serve(); } });
    const endpoint = spyOn(manager, "endpoint").mockReturnValue({ url: `http://127.0.0.1:${bridge.port}`, token: "fixture-token" });
    const error = spyOn(console, "error").mockImplementation(() => {});
    const ask = () => handleMachineRequest(new Request("http://localhost/api/machines/fixture/session"), manager);
    try {
      const over = padded({ snapshot: { secret: "fixture-session-secret" } }, 64 * MiB + 32 * MiB);
      serve = () => new Response(over.stream, { headers: { "content-type": "application/json" } });
      const refused = await ask();
      expect(refused.status).toBe(502);
      const text = await refused.text();
      expect(JSON.parse(text).error.code).toBe("remote_response_too_large");
      expect(text).not.toContain("fixture-session-secret");
      await within(over.cancelled);
      serve = () => Response.json({ ok: true });
      const next = await ask();
      expect(next.status).toBe(200);
      expect(await next.json()).toEqual({ ok: true });
      // a PC that is not connected is refused before anything is asked of it
      endpoint.mockReturnValue(undefined);
      const before = hits;
      expect((await ask()).status).toBe(503);
      expect(hits).toBe(before);
    } finally { error.mockRestore(); endpoint.mockRestore(); bridge.stop(true); manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps file streaming and 304 bodyless", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-proxy-stream-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); });
    const rest = Promise.withResolvers<void>();
    const ranges: (string | null)[] = [];
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/fs/file") {
        ranges.push(request.headers.get("range"));
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          await rest.promise;
          controller.enqueue(new TextEncoder().encode("-rest"));
          controller.close();
        } }), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-9/100", "accept-ranges": "bytes", "set-cookie": "fixture=1" } });
      }
      if (request.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      return Response.json({ messages: [] }, { headers: { etag: '"v1"' } });
    } });
    const endpoint = spyOn(manager, "endpoint").mockReturnValue({ url: `http://127.0.0.1:${bridge.port}`, token: "fixture-token" });
    try {
      const file = await handleMachineRequest(new Request("http://localhost/api/machines/fixture/fs/file?path=/v.mp4", { headers: { range: "bytes=0-9" } }), manager);
      expect(file.status).toBe(206);
      expect(ranges).toEqual(["bytes=0-9"]);
      expect(file.headers.get("content-range")).toBe("bytes 0-9/100");
      expect(file.headers.get("set-cookie")).toBeNull();
      // the first bytes arrive while the PC still holds the rest: nothing is buffered here
      const reader = file.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      rest.resolve();
      let tail = "";
      for (;;) { const { done, value } = await reader.read(); if (done) break; tail += new TextDecoder().decode(value); }
      expect(tail).toBe("-rest");
      const unchanged = await handleMachineRequest(new Request("http://localhost/api/machines/fixture/pane/conversation?pane_id=p1", { headers: { "if-none-match": '"v1"' } }), manager);
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe('"v1"');
      expect(await unchanged.text()).toBe("");
    } finally { rest.resolve(); endpoint.mockRestore(); bridge.stop(true); manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses a watching connection's writes to another PC before anything reaches that PC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-watch-proxy-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); });
    const hits: string[] = [];
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { hits.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ ok: true, commands: [] }); } });
    const endpoint = spyOn(manager, "endpoint").mockReturnValue({ url: `http://127.0.0.1:${bridge.port}`, token: "fixture" });
    const ask = (method: string, path: string, readOnly: boolean) => handleMachineRequest(new Request(`http://localhost/api/machines/fixture/${path}`, {
      method, headers: { origin: "http://localhost", "x-herdr-machine": "1", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }),
    }), manager, undefined, undefined, readOnly);
    try {
      for (const [method, path] of [["POST", "pane/input"], ["POST", "tab/create"]] as const) {
        const refused = await ask(method, path, true);
        expect(refused.status, path).toBe(403);
        expect((await refused.json() as { error: { code: string } }).error.code, path).toBe("read_only");
      }
      expect(hits).toEqual([]);
      // the block is the access check's own rule (index.ts `mutating`): what it lets a watcher send goes through
      expect((await ask("GET", "pane/read?pane_id=p", true)).status).toBe(200);
      expect((await ask("OPTIONS", "pane/input", true)).status).not.toBe(403);
      expect(hits).toEqual(["GET /api/pane/read", "OPTIONS /api/pane/input"]);
      // a connection that may drive goes through
      expect((await ask("POST", "pane/input", false)).status).toBe(200);
      expect(hits).toEqual(["GET /api/pane/read", "OPTIONS /api/pane/input", "POST /api/pane/input"]);
    } finally { endpoint.mockRestore(); bridge.stop(true); manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses a watching connection another PC's folder commands before anything reaches that PC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-watch-proxy-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); });
    const hits: string[] = [];
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { hits.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ ok: true, commands: [] }); } });
    const endpoint = spyOn(manager, "endpoint").mockReturnValue({ url: `http://127.0.0.1:${bridge.port}`, token: "fixture" });
    const ask = (method: string, path: string, readOnly: boolean) => handleMachineRequest(new Request(`http://localhost/api/machines/fixture/${path}`, {
      method, headers: { origin: "http://localhost", "x-herdr-machine": "1", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }),
    }), manager, undefined, undefined, readOnly);
    try {
      for (const [method, path] of [["GET", "agent/commands?agent=claude"]] as const) {
        const refused = await ask(method, path, true);
        expect(refused.status, path).toBe(403);
        expect((await refused.json() as { error: { code: string } }).error.code, path).toBe("read_only");
      }
      expect(hits).toEqual([]);
      // a connection that may drive goes through
      expect((await ask("GET", "agent/commands?agent=claude", false)).status).toBe(200);
      expect(hits).toEqual(["GET /api/agent/commands"]);
    } finally { endpoint.mockRestore(); bridge.stop(true); manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("separates equal pane IDs while preserving historical local storage", () => {
    expect(paneStorageId("local", "p:1")).toBe("p:1");
    expect(new Set(["local", "one", "two"].map((id) => paneStorageId(id, "p:1"))).size).toBe(3);
    expect(paneNotificationTag("p:1", "one")).not.toBe(paneNotificationTag("p:1", "two"));
    expect(machinePath("pc/name", "pane/image")).toBe("/api/machines/pc%2Fname/pane/image");
  });
  it("rejects shell and SSH-option injection in user-controlled target fields", () => {
    for (const destination of ["-oProxyCommand=touch /tmp/no", "host;id", "x\ny", "$(id)", "user@host -p 22", ""]) expect(() => validateTarget({ destination })).toThrow();
    expect(validateTarget({ destination: "user@[::1]", port: 2222, session: "work" }).port).toBe(2222);
    for (const session of ["../default", "$(id)", "work;id"]) expect(() => validateTarget({ destination: "host", session })).toThrow();
    // a key path on the web server, which may be a Windows one; never an option or a relative path
    for (const identity_file of ["/home/u/.ssh/id", "~/.ssh/id", "~\\.ssh\\id", "C:\\Users\\u\\.ssh\\id", "D:/keys/id"]) expect(validateTarget({ destination: "host", identity_file }).identity_file).toBe(identity_file);
    for (const identity_file of ["-oProxyCommand=x", "keys/id", "C:id", "~user/id", "/k\nx"]) expect(() => validateTarget({ destination: "host", identity_file })).toThrow();
    const value = "a'$(touch /tmp/no)";
    expect(Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]).stdout.toString()).toBe(value);
  });
  it("rejects cross-origin controls and limits secret submission to secure origins", () => {
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://evil.test" } }))).toBe(false);
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://localhost:7317" } }))).toBe(true);
    expect(canSendSecret(new Request("http://192.0.2.1/api/machines"))).toBe(false);
    expect(canSendSecret(new Request("https://app.example/api/machines"))).toBe(true);
    expect(canSendSecret(new Request("http://127.0.0.1/api/machines"))).toBe(true);
  });
  it("proxies only pane/workspace data and never remote management credentials", () => {
    for (const path of ["pane/focus", "layout/ratio", "tab/move"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
    for (const path of ["pane/focus/extra", "pane/move", "layout/apply", "layout/ratio/extra", "layout/../auth", "agent/commands/extra", "agent/start"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    // the commands an agent offers in a folder before any pane runs it (the new workspace and tab dialogs)
    for (const path of ["agent/rename", "agent/commands"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
    // the install catalog a PC answers for itself, and an install or sign-in started on that PC; nothing else under it
    for (const path of ["agent-catalog", "agent-catalog/install", "agent-catalog/sign-in"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
    for (const path of ["agent-catalog/uninstall", "agent-catalog/install/extra", "agent-catalog/../auth"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    for (const path of ["auth", "push", "updates/install", "machines/setup", "bridge", "../auth", "pane/../../auth", "pane/prompt/answer/extra", "pane/rewind", "tab/move/extra", "tab/close/extra"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    for (const path of ["session", "agents", "integrations", "pane/files", "pane/find", "pane/image", "pane/prompt/answer", "pane/omo-tasks", "pane/background-agent", "pane/input", "workspace/create", "tab/create", "tab/rename", "tab/close"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
    for (const path of ["session", "agents", "integrations", "pane/files", "pane/find", "pane/image", "pane/prompt/answer", "pane/split", "pane/zoom", "pane/swap", "pane/resize", "pane/clear", "workspace/create", "tab/create", "tab/rename", "tab/close"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
  });
});

// A setup job placed directly in the manager: driving a whole setup needs a real SSH host, but
// action() and stage() are the code that decides what the dialog shows.
type TestJob = { public: SetupJob; abort: AbortController; timer: ReturnType<typeof setTimeout>; stageStartedAt: number; pending?: { resolve(value: string): void; reject(error: Error): void }; update: boolean; auto: boolean; finished: Promise<void>; headlessStart?: boolean };
describe("setup job labels", () => {
  const dirs: string[] = [];
  const managers: MachineManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fixture(phase: SetupJob["phase"], step: string, challenge: SetupJob["challenge"] = null) {
    const dir = mkdtempSync(join(tmpdir(), "herdr-machines-"));
    dirs.push(dir);
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker);
    managers.push(manager);
    const job: TestJob = {
      public: { id: "job", machine_id: "machine", target: { destination: "pc" }, phase, step, challenge, installations: [], error: null, ssh_output: null, progress: null },
      abort: new AbortController(), timer: setTimeout(() => {}, 0), stageStartedAt: Date.now(), update: false, auto: false, finished: Promise.resolve(),
    };
    clearTimeout(job.timer);
    job.pending = { resolve: () => {}, reject: () => {} };
    (manager as unknown as { jobs: Map<string, TestJob> }).jobs.set("job", job);
    const drive = manager as unknown as { stage(job: TestJob, phase: SetupJob["phase"], step: string): void; progress(job: TestJob, stage: "download" | "upload" | "install" | "restart", done: number, total: number | null): void };
    return { manager, job, drive };
  }

  it("drops the review heading as soon as an approval is given", () => {
    const { manager, job } = fixture("approval", "Review the changes on this PC");
    manager.action("job", { action: "approve" });
    expect(manager.job("job")?.phase).toBe("installing");
    expect(manager.job("job")?.step).not.toBe("Review the changes on this PC");
    expect(job.public.step).toBe("Installing on this PC…");
  });

  it("requires current Windows-login consent for each headless start and rejects duplicate or cancelled requests", () => {
    const { manager, job } = fixture("starting", "Waiting for Windows sign-in on this PC.");
    job.pending = undefined;
    expect(() => manager.action("job", { action: "start_headless" })).toThrow("not waiting");
    job.public.action_required = "windows_login";
    manager.action("job", { action: "start_headless" });
    expect(job.headlessStart).toBe(true);
    expect(manager.job("job")?.action_required).toBeNull();
    expect(() => manager.action("job", { action: "start_headless" })).toThrow("not waiting");
    job.headlessStart = false;
    job.public.action_required = "windows_login";
    manager.action("job", { action: "cancel" });
    expect(() => manager.action("job", { action: "start_headless" })).toThrow("not waiting");
    expect(job.headlessStart).toBe(false);
  });

  it("keeps retrying a login-waiting PC and reattaches its existing setup without changing the SSH target", () => {
    const { manager, job } = fixture("starting", "Waiting for Windows sign-in on this PC.");
    job.public.action_required = "windows_login";
    type Waiting = { machine: { enabled: boolean; action_required?: string | null; state: string }; generation: number; retry?: unknown };
    const internals = manager as unknown as { machines: Map<string, Waiting>; runtime(machine: unknown): Waiting; lost(runtime: Waiting, generation: number, error: Error): void };
    const runtime = internals.runtime({ id: "machine", name: "pc", kind: "ssh", enabled: true, state: "connected", target: { destination: "pc" }, snapshot: null, error: null });
    internals.machines.set("machine", runtime);
    internals.lost(runtime, runtime.generation, new MachineActionRequired("Waiting for Windows sign-in on this PC.", "windows_login"));
    expect(runtime.machine.state).toBe("reconnecting");
    expect(runtime.machine.action_required).toBe("windows_login");
    expect(runtime.retry).toBeDefined();
    expect(manager.setup({ destination: "pc", machine_id: "machine" }).id).toBe("job");
    expect(() => manager.setup({ destination: "another-pc", machine_id: "machine" })).toThrow("already running");
    manager.patch("machine", { enabled: false });
    expect(runtime.machine.action_required).toBeNull();
    expect(runtime.machine.state).toBe("disconnected");
    expect(runtime.retry).toBeUndefined();
  });

  it("consumes headless consent once even on failure, and cancels before another waiting-loop launch", async () => {
    const inspection = { platform: "win32-x64" as const, home: "C:\\Users\\u", herdrPath: "C:\\herdr.exe", expectedSocket: "C:\\socket", bundleReady: true, bundleOlder: false, descriptors: [], runtimeDir: "C:\\runtime", registryDir: "C:\\registry" };
    const mocks = [
      spyOn(windowsHost, "inspect").mockResolvedValue(inspection),
      spyOn(windowsHost, "herdrVersion").mockResolvedValue("herdr 0.9.5"),
      spyOn(windowsHost, "descriptors").mockResolvedValue([]),
      spyOn(windowsHost, "startupNotice").mockResolvedValue("Waiting for Windows sign-in on this PC."),
      spyOn(Bun, "sleep").mockResolvedValue(undefined),
    ];
    try {
      for (const decision of ["force", "cancel", "move"] as const) {
        const { manager, job } = fixture("checking", "Checking the remote environment…");
        job.auto = true;
        if (decision === "move") job.public.target = { destination: "another-pc" };
        const waiting = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
        const drive = manager as unknown as { runtime(machine: unknown): { ssh: unknown; machine: { action_required?: string } }; prepare(runtime: unknown, job: TestJob): Promise<void>; pause(): Promise<void> };
        drive.pause = () => { waiting.resolve(); return resume.promise; };
        const runtime = drive.runtime({ id: "machine", name: "pc", kind: "ssh", enabled: true, target: { destination: "pc" }, snapshot: null, error: null });
        runtime.ssh = { run: async () => { throw new Error("no sh on Windows"); }, close() {} };
        const starts: boolean[] = [];
        const start = spyOn(windowsHost, "start").mockImplementation(async (_ssh, options) => {
          starts.push(options.headless === true);
          if (options.headless) throw new Error("forced launch failed");
        });
        try {
          const outcome = drive.prepare(runtime, job).then(() => null, (error: Error) => error);
          await within(waiting.promise, "the setup did not wait for Windows sign-in");
          if (decision === "move") expect(runtime.machine.action_required).not.toBe("windows_login");
          manager.action("job", { action: decision === "cancel" ? "cancel" : "start_headless" });
          resume.resolve();
          expect((await outcome)?.message).toBe(decision === "cancel" ? "Setup cancelled" : "forced launch failed");
          expect(starts).toEqual(decision === "cancel" ? [false] : [false, true]);
          expect(job.headlessStart).toBe(false);
        } finally { start.mockRestore(); }
      }
    } finally { for (const mock of mocks) mock.mockRestore(); }
  });

  it("drops the SSH question's heading as soon as it is answered", () => {
    for (const [step, kind] of [["Verify the server fingerprint", "host_key"], ["SSH authentication required", "secret"]] as const) {
      const { manager } = fixture("authentication", step, { id: "c1", kind, prompt: "?" });
      manager.action("job", { action: "answer", challenge_id: "c1", answer: kind === "host_key" ? "yes" : "pw" });
      expect(manager.job("job")?.phase).toBe("connecting");
      expect(manager.job("job")?.step).not.toBe(step);
    }
  });

  function windowsSetup(bundleReady = true) {
    const { manager } = fixture("cancelled", "Cancelled");
    manager["jobs"].delete("job");
    const runtime = manager["runtime"]({ id: "windows", name: "pc", kind: "ssh", enabled: true, state: "reconnecting", action_required: "windows_login", target: { destination: "pc" }, snapshot: null, error: null });
    manager["machines"].set("windows", runtime);
    manager["retryLater"](runtime);
    const approval = Promise.withResolvers<void>(), waiting = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const wait = manager["wait"].bind(manager);
    manager["wait"] = (job) => { const answer = wait(job); approval.resolve(); return answer; };
    manager["pause"] = async (signal) => {
      waiting.resolve();
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        signal?.addEventListener("abort", done, { once: true });
        void resume.promise.then(() => { signal?.removeEventListener("abort", done); resolve(); });
      });
    };
    const mocks = [
      spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
      spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("no sh on Windows")),
      spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
      spyOn(windowsHost, "inspect").mockResolvedValue({ platform: "win32-x64", home: "C:\\Users\\u", herdrPath: "C:\\herdr.exe", expectedSocket: "C:\\socket", bundleReady, bundleOlder: !bundleReady, descriptors: [], runtimeDir: "C:\\runtime", registryDir: "C:\\registry" }),
      spyOn(windowsHost, "herdrVersion").mockResolvedValue("herdr 0.9.5"),
      spyOn(windowsHost, "installBundle").mockResolvedValue(undefined),
      spyOn(windowsHost, "start").mockResolvedValue(undefined),
      spyOn(windowsHost, "descriptors").mockResolvedValue([]),
      spyOn(windowsHost, "startupNotice").mockResolvedValue("Waiting for Windows sign-in on this PC."),
      spyOn(Bun, "sleep").mockResolvedValue(undefined),
    ];
    return { manager, runtime, approval, waiting, resume, close: () => { manager.stop(); resume.resolve(); for (const mock of mocks) mock.mockRestore(); } };
  }

  for (const phase of ["approval", "starting"] as const) it(`resumes a saved Windows retry when startup review is cancelled during ${phase}`, async () => {
    // Given a dialog which has pre-empted a saved PC's background reconnection.
    const f = windowsSetup();
    try {
      const job = f.manager.setup({ destination: "pc", machine_id: "windows" });
      await within(f.approval.promise);
      if (phase === "starting") {
        f.manager.action(job.id, { action: "approve" });
        await within(f.waiting.promise);
      }
      // When Cancel connection or dialog unmount cancels that job.
      f.manager.action(job.id, { action: "cancel" });
      await f.manager["jobs"].get(job.id)?.finished;
      // Then background reconnection is restored, without headless consent.
      expect(job.phase).toBe("cancelled");
      expect(f.runtime.machine.state).toBe("reconnecting");
      expect(f.runtime.retry).toBeDefined();
      expect(f.manager["jobs"].get(job.id)?.headlessStart).toBe(false);
    } finally { f.close(); }
  });

  for (const bundleReady of [true, false]) it(`resumes a saved Windows retry when sign-in expires ${bundleReady ? "without installation" : "after installation clears the setup deadline"}`, async () => {
    // Given a setup waiting for sign-in, with or without an installation stage.
    const f = windowsSetup(bundleReady);
    const deadlines = new Map<number, () => void>();
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(set, {
      apply(target, _receiver, [fn, delay, ...args]: unknown[]) {
        if (typeof fn !== "function" || delay !== undefined && typeof delay !== "number") throw new Error("Expected a timer callback and delay");
        const callback = () => fn(...args);
        const handle = target(callback, delay);
        if (delay === 600_000) deadlines.set(Number(handle), callback);
        return handle;
      },
    }));
    const cleared = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => { deadlines.delete(Number(handle)); clear(Number(handle)); });
    try {
      const job = f.manager.setup({ destination: "pc", machine_id: "windows" });
      await within(f.approval.promise);
      f.manager.action(job.id, { action: "approve" });
      await within(f.waiting.promise);
      const state = f.manager["jobs"].get(job.id);
      if (!state) throw new Error("Setup job missing");
      const expire = deadlines.get(Number(state.timer));
      expect(expire).toBeDefined();
      if (!expire) return;
      // When the active deadline expires, without waiting on wall-clock time.
      expire();
      await state.finished;
      // Then this is a timeout, not explicit cancellation, and the PC keeps retrying.
      expect(job.phase).toBe("failed");
      expect(f.runtime.machine.state).toBe("reconnecting");
      expect(f.runtime.retry).toBeDefined();
      expect(f.runtime.updateCancelled).not.toBe(true);
    } finally { timer.mockRestore(); cleared.mockRestore(); f.close(); }
  });

  it("releases the automatic update queue when Windows needs sign-in", async () => {
    // Given an old Windows bundle followed by another PC in the global update queue.
    const f = windowsSetup(false);
    f.runtime.machine.action_required = "update_bridge";
    const linux = f.manager["runtime"]({ id: "linux", name: "linux", kind: "ssh", enabled: true, state: "error", action_required: "update_bridge", target: { destination: "linux" }, snapshot: null, error: null });
    f.manager["machines"].set("linux", linux);
    const second = Promise.withResolvers<void>();
    const update = f.manager.updateBridge.bind(f.manager);
    const started: string[] = [];
    const updates = spyOn(f.manager, "updateBridge").mockImplementation((id, scheduled) => {
      started.push(id);
      const job = update(id, scheduled);
      if (id === "linux") { f.manager.action(job.id, { action: "cancel" }); second.resolve(); }
      return job;
    });
    try {
      // When both updates are queued, nobody signs in or cancels Windows.
      f.manager["queueAutoUpdate"]("windows");
      f.manager["queueAutoUpdate"]("linux");
      await within(second.promise, "Windows sign-in held the automatic update queue");
      await f.manager["autoChain"];
      // Then the next update starts while Windows reconnects with startup choices available.
      expect(started).toEqual(["windows", "linux"]);
      expect(f.runtime.machine).toMatchObject({ action_required: "windows_login", state: "reconnecting" });
      expect(f.runtime.retry).toBeDefined();
    } finally { updates.mockRestore(); f.close(); }
  }, 10_000);

  for (const automatic of [false, true]) for (const refused of [false, true]) it(`waits for delayed Windows startup status during ${automatic ? "automatic update" : "initial setup"} (${refused ? "scheduler failure" : "sign-in"})`, async () => {
    // Given a launcher which publishes its result only at its 30-second deadline.
    const f = windowsSetup(!automatic);
    if (!automatic) f.manager["machines"].delete("windows");
    else f.runtime.machine.state = "error";
    let elapsed = 0;
    const result = refused ? "Task registration denied" : "Waiting for Windows sign-in on this PC.";
    const action = refused ? "windows_start_failed" : "windows_login";
    const sleep = spyOn(Bun, "sleep").mockImplementation(async (ms) => { elapsed += Number(ms); });
    const notice = spyOn(windowsHost, "startupNotice").mockImplementation(async () => elapsed >= 30_000 ? result : null);
    try {
      // When setup or an unattended update starts that launcher.
      const job = automatic ? f.manager.updateBridge("windows", true) : f.manager.setup({ destination: "pc" });
      if (!automatic) { await within(f.approval.promise); f.manager.action(job.id, { action: "approve" }); }
      const state = f.manager["jobs"].get(job.id);
      if (!state) throw new Error("Setup job missing");
      await within(Promise.race([f.waiting.promise, state.finished]));
      // Then startup options survive the delay; only a sign-in wait retries in the background.
      expect(job.action_required).toBe(action);
      expect(elapsed).toBeGreaterThanOrEqual(30_000);
      if (automatic) {
        expect(f.runtime.machine).toMatchObject({ state: refused ? "error" : "reconnecting", action_required: action, error: result });
        if (refused) expect(f.runtime.retry).toBeUndefined();
        else expect(f.runtime.retry).toBeDefined();
      } else expect(job.phase).toBe("starting");
    } finally { sleep.mockRestore(); notice.mockRestore(); f.close(); }
  });

  for (const headless of [false, true]) it(`restores saved Windows retries when ${headless ? "headless startup fails" : "SSH drops during sign-in waiting"}`, async () => {
    // Given a saved PC whose startup review has replaced its background connection.
    const f = windowsSetup();
    if (!headless) f.runtime.machine.state = "disconnected";
    const failure = headless ? "Headless launch failed" : "SSH connection ended";
    try {
      const job = f.manager.setup({ destination: "pc", machine_id: "windows" });
      await within(f.approval.promise);
      f.manager.action(job.id, { action: "approve" });
      await within(f.waiting.promise);
      const failed = headless
        ? spyOn(windowsHost, "start").mockRejectedValue(new Error(failure))
        : spyOn(windowsHost, "descriptors").mockRejectedValue(new Error(failure));
      try {
        // When the waiting connection drops, or its explicit headless launch fails.
        if (headless) f.manager.action(job.id, { action: "start_headless" });
        f.resume.resolve();
        await f.manager["jobs"].get(job.id)?.finished;
        // Then the failure stays visible while the enabled saved PC retries.
        expect(job.phase).toBe("failed");
        expect(f.runtime.machine).toMatchObject({ state: "reconnecting", error: failure, action_required: null });
        expect(f.runtime.retry).toBeDefined();
      } finally { failed.mockRestore(); }
    } finally { f.close(); }
  });

  for (const automatic of [false, true]) it(`stops retrying scheduler failures during ${automatic ? "automatic update" : "background reconnection"}`, async () => {
    // Given a real startup-status reader receiving a Task Scheduler failure.
    const startupNotice = windowsHost.startupNotice;
    const f = windowsSetup(!automatic);
    const failure = "Task registration denied (0x80070005)";
    windowsHost.startupNotice = startupNotice;
    const reader = spyOn(SshConnection.prototype, "runPowerShell").mockResolvedValue(`interactive_failed: ${failure}`);
    try {
      // When an unattended connection encounters the scheduler refusal.
      if (automatic) {
        const job = f.manager.updateBridge("windows", true);
        await f.manager["jobs"].get(job.id)?.finished;
        expect(job.action_required).toBe("windows_start_failed");
      } else await f.manager["reconnect"](f.runtime);
      // Then it offers startup review with the actual failure, without endless retries.
      expect(f.runtime.machine).toMatchObject({ state: "error", action_required: "windows_start_failed", error: failure });
      expect(f.runtime.retry).toBeUndefined();
    } finally { reader.mockRestore(); f.close(); }
  });

  it("offers one-time headless consent when the Windows scheduler refuses startup", async () => {
    // Given a scheduler failure transported through the real startup-status reader.
    const startupNotice = windowsHost.startupNotice;
    const f = windowsSetup();
    const schedulerError = "Task registration denied (0x80070005)";
    // Restore the reader that this fixture normally replaces.
    const statusReader = spyOn(SshConnection.prototype, "runPowerShell").mockResolvedValue(`interactive_failed: ${schedulerError}`);
    windowsHost.startupNotice = startupNotice;
    const forced = Promise.withResolvers<void>();
    const starts: boolean[] = [];
    const start = spyOn(windowsHost, "start").mockImplementation(async (_ssh, options) => {
      starts.push(options.headless === true);
      if (options.headless) { forced.resolve(); throw new Error("fixture stops after consent is consumed"); }
    });
    try {
      const job = f.manager.setup({ destination: "pc", machine_id: "windows" });
      await within(f.approval.promise);
      f.manager.action(job.id, { action: "approve" });
      await within(f.waiting.promise, "scheduler failure did not offer startup choices");
      expect(job.step).toBe(schedulerError);
      expect(job.action_required).toBe("windows_start_failed");
      // When the user explicitly chooses a headless start.
      f.manager.action(job.id, { action: "start_headless" });
      f.resume.resolve();
      await within(forced.promise);
      await f.manager["jobs"].get(job.id)?.finished;
      // Then only that next launch carries headless consent.
      expect(starts).toEqual([false, true]);
      expect(f.manager["jobs"].get(job.id)?.headlessStart).toBe(false);
    } finally { start.mockRestore(); statusReader.mockRestore(); f.close(); }
  }, 10_000);

  it("labels the first start of a bridge as its own step, not as a restart", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.progress(job, "install", 0, null);
    drive.stage(job, "starting", "Starting the remote bridge…");
    expect(manager.job("job")?.step).toBe("Starting the remote bridge…");
    expect(manager.job("job")?.progress).toBeNull();
    expect(describeProgress(manager.job("job")?.progress)).toBeNull();
  });

  it("keeps the restart label for the restart of a bridge update", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.stage(job, "starting", "Restarting the verified remote bridge…");
    drive.progress(job, "restart", 0, null);
    expect(describeProgress(manager.job("job")?.progress)?.label).toBe("Restarting the bridge");
  });

  it("shows a step without byte progress by its own text, not the previous stage's label", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.progress(job, "install", 0, null);
    expect(describeProgress(manager.job("job")?.progress)?.label).toBe("Verifying and installing");
    drive.stage(job, "installing", "Registering the app SSH key…");
    expect(manager.job("job")?.progress).toBeNull();
    expect(describeProgress(manager.job("job")?.progress)).toBeNull();
  });
});

describe("SSH output during setup", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  /** A PC whose ssh prints a line and then waits for the user, like Tailscale SSH's browser check. */
  function waitingSsh(script: string): MachineManager {
    const root = mkdtempSync(join(tmpdir(), "herdr-ssh-output-"));
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", bin]);
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    const manager = new MachineManager(join(root, "state"), {} as PushService, new CompletionTracker(null));
    // stop() cancels the job, which kills the fake ssh (it `exec`s sleep, so there is no orphan)
    cleanups.push(() => { manager.stop(); process.env["PATH"] = path; rmSync(root, { recursive: true, force: true }); });
    return manager;
  }
  async function until<T>(read: () => T | undefined | null | false): Promise<T> {
    for (let i = 0; i < 100; i += 1) { const value = read(); if (value) return value; await Bun.sleep(50); }
    throw new Error("timed out");
  }

  it("shows what ssh printed while it is still waiting, and drops it once the setup is cancelled", async () => {
    const manager = waitingSsh(`echo "To authenticate, visit: https://login.tailscale.com/a/check123" >&2\nexec sleep 30`);
    const started = manager.setup({ destination: "check-pc" });
    expect(started.ssh_output).toBeNull();
    const job = await until(() => manager.job(started.id)?.ssh_output ? manager.job(started.id) : null);
    expect(job.phase).toBe("connecting");
    expect(job.ssh_output).toBe("To authenticate, visit: https://login.tailscale.com/a/check123");
    // the dialog polls this route: the line has to be in its answer, not only on the manager
    const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/setup/${started.id}`, { headers: { origin: "http://localhost:7317" } }), manager);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "connecting", ssh_output: "To authenticate, visit: https://login.tailscale.com/a/check123" });
    manager.action(started.id, { action: "cancel" });
    expect(manager.job(started.id)).toMatchObject({ phase: "cancelled", ssh_output: null });
  });

  it("keeps only the recent lines, without terminal control characters", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(recentSshOutput(lines).split("\n")).toEqual(["line 12", "line 13", "line 14", "line 15", "line 16", "line 17", "line 18", "line 19"]);
    expect(recentSshOutput("\x1b[31mred\x1b[0m\r\n\n  \nspinner\rdone\x07\n")).toBe("red\nspinner\ndone");
    expect(recentSshOutput("x".repeat(5000)).length).toBe(2048);
    expect(recentSshOutput("")).toBe("");
  });
});

// A first connect that finds another version's bridge fails before the PC is ever registered,
// so the sidebar has no row to put the update button on: the job has to carry the action itself.
// ssh's run() is answered in place of a PC (a PATH-swapped fake cannot serve it: spawned runs
// never see the swapped PATH), so setup() fails inside its own catch — where the action is set.
describe("a first connect that finds a bridge of another version", () => {
  const socket = "/home/u/.config/herdr/herdr.sock";
  const descriptor = { pid: 4242, port: 29431, token: "a".repeat(64), socket_path: socket, bridge_protocol: 1, bundle_version: "0", managed_remote: true };
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close };
  afterEach(() => { Object.assign(SshConnection.prototype, real); });

  it("fails the job with action_required, which the dialog's poll reads", async () => {
    SshConnection.prototype.start = async () => {};
    SshConnection.prototype.run = (async (script: string) => {
      if (script.includes("uname")) return `Linux\nx86_64\n/home/u\n/home/u/.config\n\n${JSON.stringify(descriptor)}\n`;
      if (script.includes("socket=")) return socket;
      if (script.includes("kill -0")) return "live";
      throw new Error("Unexpected remote mutation");
    }) as typeof real.run;
    SshConnection.prototype.close = () => {};
    const dir = mkdtempSync(join(tmpdir(), "herdr-stale-bridge-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null));
    try {
      const started = manager.setup({ destination: "stale-pc" });
      for (let i = 0; i < 100 && !["failed", "connected"].includes(manager.job(started.id)?.phase ?? ""); i += 1) await Bun.sleep(25);
      const job = manager.job(started.id)!;
      expect(job.phase).toBe("failed");
      expect(job.error).toContain("different version");
      expect(job.action_required).toBe("update_bridge");
      // the dialog polls this route: the action has to be in its answer, not only on the manager
      const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/setup/${started.id}`, { headers: { origin: "http://localhost:7317" } }), manager);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ phase: "failed", action_required: "update_bridge" });
      // and the PC was never registered, so the job is the dialog's only signal
      expect(manager.list().map((machine) => machine.kind)).toEqual(["local"]);
    } finally { manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("tells this app to update itself when an independently managed web server is newer", async () => {
    const newer = String(Number(REMOTE_BUNDLE_VERSION) + 1);
    const independent = { ...descriptor, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: newer, managed_remote: false };
    SshConnection.prototype.start = async () => {};
    SshConnection.prototype.run = (async (script: string) => {
      if (script.includes("uname")) return `Linux\nx86_64\n/home/u\n/home/u/.config\n\n${JSON.stringify(independent)}\n`;
      if (script.includes("socket=")) return socket;
      if (script.includes("kill -0")) return "live";
      throw new Error("Unexpected remote mutation");
    }) as typeof real.run;
    SshConnection.prototype.close = () => {};
    const dir = mkdtempSync(join(tmpdir(), "herdr-independent-bridge-"));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null));
    try {
      const started = manager.setup({ destination: "independent-pc" });
      for (let i = 0; i < 100 && !["failed", "connected"].includes(manager.job(started.id)?.phase ?? ""); i += 1) await Bun.sleep(25);
      const job = manager.job(started.id)!;
      // this app cannot update that server, and that server is already the newer one: this app is
      // the side that is behind (a Mac on 0.4.13 met a PC already on 0.4.16 and was sent to the PC)
      expect(job).toMatchObject({ phase: "failed", action_required: "setup" });
      expect(job.error).toContain("independently managed");
      expect(job.error).toContain(`(v${newer})`);
      expect(job.error).toContain("Update this app");
      expect(job.error).not.toContain("its own Settings");
    } finally { manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// A bridge update that cannot reach its PC (switched off, asleep, gone in the middle) learned
// nothing about the bridge: the PC waits as offline and checks the version again once it answers,
// instead of asking for an update it cannot run. A PC that refuses the key keeps the button.
describe("a bridge update on a PC that cannot be reached", () => {
  const id = "0b9d6a52-7a5e-4f8e-9a51-2f3c4d5e6f70";
  const socket = "/home/u/.config/herdr/herdr.sock";
  const descriptor = { pid: 4242, port: 29431, token: "a".repeat(64), socket_path: socket, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: "0", managed_remote: true };
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, connected: SshConnection.prototype.connected };
  afterEach(() => { Object.assign(SshConnection.prototype, real); });

  async function updateOnce(options: { start: () => Promise<void>; connected?: boolean; failRun?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "herdr-offline-update-"));
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "macbook", enabled: false, target: { destination: "macbook" }, snapshot: null }]));
    SshConnection.prototype.start = options.start;
    SshConnection.prototype.connected = () => options.connected ?? true;
    SshConnection.prototype.run = (async (script: string) => {
      if (script.includes("uname")) return `Linux\nx86_64\n/home/u\n/home/u/.config\n\n${JSON.stringify(descriptor)}\n`;
      if (script.includes("socket=")) return socket;
      // the bridge check after the host was read: the connection drops (or the check fails) here
      if (script.includes("kill -0")) { if (options.failRun) throw new Error("Connection to macbook closed by remote host."); return "live"; }
      throw new Error("Unexpected remote mutation");
    }) as typeof real.run;
    SshConnection.prototype.close = () => {};
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); });
    // registered disabled so no reconnect of its own runs; enabled again without a reconnect,
    // as a PC that was connected when its update began
    (manager as unknown as { machines: Map<string, { machine: { enabled: boolean } }> }).machines.get(id)!.machine.enabled = true;
    try {
      const started = manager.updateBridge(id);
      for (let i = 0; i < 100 && manager.job(started.id)?.phase !== "failed"; i += 1) await Bun.sleep(25);
      // copied: stop() below disconnects the live record
      return structuredClone({ job: manager.job(started.id)!, machine: manager.list().find((machine) => machine.id === id)! });
    } finally { manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  }

  it("waits as offline when SSH cannot reach the PC", async () => {
    const { job, machine } = await updateOnce({ start: async () => { throw new Error("ssh: connect to host macbook port 22: Operation timed out"); } });
    expect(job.phase).toBe("failed");
    expect(machine).toMatchObject({ state: "reconnecting", action_required: null });
    expect(machine.error).toContain("Operation timed out");
  });

  it("waits as offline when the PC goes away in the middle of the update", async () => {
    const { machine } = await updateOnce({ start: async () => {}, connected: false, failRun: true });
    expect(machine).toMatchObject({ state: "reconnecting", action_required: null });
  });

  it("waits as offline when ssh only warns that a local key file is unreadable", async () => {
    const { machine } = await updateOnce({ start: async () => { throw new Error("Warning: Identity file /home/u/.ssh/id_work not accessible: Permission denied.\r\nssh: connect to host macbook port 22: Connection timed out"); } });
    expect(machine).toMatchObject({ state: "reconnecting", action_required: null });
  });

  it("keeps the update button when the PC refuses the saved key", async () => {
    const { machine } = await updateOnce({ start: async () => { throw new Error("u@macbook: Permission denied (publickey)."); } });
    expect(machine).toMatchObject({ state: "error", action_required: "update_bridge" });
  });

  it("keeps the update button when the update fails on a PC that still answers", async () => {
    const { machine } = await updateOnce({ start: async () => {}, connected: true, failRun: true });
    expect(machine).toMatchObject({ state: "error", action_required: "update_bridge" });
  });

  it("counts a killed SSH master as gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-killed-master-"));
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const ssh = new SshConnection({ destination: "macbook" }, dir);
      const master = Bun.spawn(["sleep", "30"]);
      (ssh as unknown as { master: typeof master }).master = master;
      expect(ssh.connected()).toBe(true);
      master.kill(signal);
      await master.exited;
      // Bun leaves exitCode null after a signal and sets signalCode
      expect(ssh.connected()).toBe(false);
      real.close.call(ssh);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the user's Update bridge take back a Cancel, and keeps a queued automatic update from undoing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-cancel-flag-"));
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "macbook", enabled: false, target: { destination: "macbook" }, snapshot: null }]));
    SshConnection.prototype.start = async () => { throw new Error("ssh: connect to host macbook port 22: Connection timed out"); };
    SshConnection.prototype.close = () => {};
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); });
    type Internals = { machines: Map<string, { updateCancelled?: boolean; machine: { enabled: boolean; state: string; action_required: string | null } }>; jobs: Map<string, { finished: Promise<void> }>; autoChain: Promise<void>; queueAutoUpdate(id: string): void };
    const internals = manager as unknown as Internals;
    const runtime = internals.machines.get(id)!;
    Object.assign(runtime.machine, { enabled: true, state: "error", action_required: "update_bridge" });
    try {
      // an automatic update queued before the Cancel, which runs once the one ahead of it is done
      runtime.updateCancelled = true;
      internals.queueAutoUpdate(id);
      await internals.autoChain;
      expect(internals.jobs.size).toBe(0);
      // a scheduled update keeps the Cancel, the user's button takes it back
      await internals.jobs.get(manager.updateBridge(id, true).id)!.finished;
      expect(runtime.updateCancelled).toBe(true);
      Object.assign(runtime.machine, { state: "error", action_required: "update_bridge" });
      await internals.jobs.get(manager.updateBridge(id).id)!.finished;
      expect(runtime.updateCancelled).toBe(false);
    } finally { manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  // The record a live server showed for a switched-off MacBook: an earlier failed update left the
  // button and its error, then an update that was cancelled (Cancel update, a closed dialog, the
  // setup's time limit) disconnected the PC and kept both, with no reconnect ever scheduled.
  it("reconnects after a cancelled update, and asks again only once the PC answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-cancelled-update-"));
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "macbook", enabled: false, target: { destination: "macbook" }, snapshot: null }]));
    let reachable = false;
    SshConnection.prototype.start = async () => { await Bun.sleep(100); if (!reachable) throw new Error("ssh: connect to host macbook port 22: Connection timed out"); };
    SshConnection.prototype.connected = () => true;
    SshConnection.prototype.run = (async (script: string) => {
      if (script.includes("uname")) return `Linux\nx86_64\n/home/u\n/home/u/.config\n\n${JSON.stringify(descriptor)}\n`;
      if (script.includes("socket=")) return socket;
      if (script.includes("kill -0")) return "live";
      throw new Error("Unexpected remote mutation");
    }) as typeof real.run;
    SshConnection.prototype.close = () => {};
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); });
    const internals = manager as unknown as { machines: Map<string, { machine: { enabled: boolean; state: string; action_required: string | null; error: string | null } }>; jobs: Map<string, unknown> };
    const record = internals.machines.get(id)!.machine;
    Object.assign(record, { enabled: true, state: "error", action_required: "update_bridge", error: "mux_client_request_session: read from master failed: Broken pipe" });
    const view = () => structuredClone(manager.list().find((machine) => machine.id === id)!);
    try {
      const started = manager.updateBridge(id);
      manager.action(started.id, { action: "cancel" });
      await (internals.jobs.get(started.id) as { finished: Promise<void> }).finished;
      expect(manager.job(started.id)!.phase).toBe("cancelled");
      expect(view()).toMatchObject({ state: "reconnecting", action_required: null });
      // the PC answers with an old bridge: the button comes back, and the cancelled update does
      // not start again by itself
      reachable = true;
      for (let i = 0; i < 120 && view().state !== "error"; i += 1) await Bun.sleep(25);
      expect(view()).toMatchObject({ state: "error", action_required: "update_bridge", updating: null });
      await Bun.sleep(50);
      expect(internals.jobs.size).toBe(1);
    } finally { manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  // A MacBook that slept through a few tries wakes to a delay of up to a minute: the chat the
  // user opens then asks for the PC, and that ask is what starts the next try.
  it("tries a waiting PC again when a chat asks for it, at most once per interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-retry-now-"));
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "macbook", enabled: false, target: { destination: "macbook" }, snapshot: null }]));
    let starts = 0;
    SshConnection.prototype.start = async () => { starts += 1; throw new Error("ssh: connect to host macbook port 22: Network is unreachable"); };
    SshConnection.prototype.close = () => {};
    let clock = 0;
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); }, { now: () => clock });
    type Waiting = { machine: { enabled: boolean; state: string }; attempts: number; retry?: unknown };
    const internals = manager as unknown as { machines: Map<string, Waiting>; retryLater(runtime: Waiting): void; jobs: Map<string, { finished: Promise<void> }> };
    const runtime = internals.machines.get(id)!;
    runtime.machine.enabled = true;
    // six failed tries already: the next waits a minute
    runtime.attempts = 6;
    internals.retryLater(runtime);
    const conversation = () => handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${id}/pane/conversation?pane_id=w1%3Ap1`), manager);
    const waitingAgain = async () => { for (let i = 0; i < 100 && runtime.retry === undefined; i += 1) await Promise.resolve(); expect(runtime.retry).toBeDefined(); };
    try {
      expect((await conversation()).status).toBe(503);
      expect(starts).toBe(1);
      await waitingAgain();
      // the try failed and the PC waits again; another read within the interval starts none
      expect((await conversation()).status).toBe(503);
      expect(starts).toBe(1);
      clock += 5000;
      expect((await conversation()).status).toBe(503);
      expect(starts).toBe(2);
      await waitingAgain();
      // a bridge update that could not reach the PC was a try as well: the next read waits the interval
      clock += 5000;
      await internals.jobs.get(manager.updateBridge(id).id)!.finished;
      expect(starts).toBe(3);
      expect(runtime.retry).toBeDefined();
      expect((await conversation()).status).toBe(503);
      expect(starts).toBe(3);
      // a PC that is switched off is never tried
      runtime.machine.enabled = false;
      clock += 5000;
      await conversation();
      expect(starts).toBe(3);
    } finally { manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("terminal attach capability", () => {
  it("follows herdr's own word when it gives one, and the platform otherwise", () => {
    expect(terminalAttachSupported({ direct_terminal_attach: false, live_handoff: true })).toBe(false);
    expect(terminalAttachSupported({ direct_terminal_attach: true })).toBe(true);
    expect(terminalAttachSupported({ live_handoff: true })).toBe(process.platform !== "win32");
    expect(terminalAttachSupported(undefined)).toBe(process.platform !== "win32");
  });

  it("mirrors a PC whose bridge cannot run the PTY sidecar, whatever herdr declares", () => {
    const declared = { version: "0.9.9", protocol: 22, terminal_attach: terminalAttachSupported({ direct_terminal_attach: true }) };
    expect(attachableIdentity(declared, false)).toEqual({ version: "0.9.9", protocol: 22, terminal_attach: false, terminal_mirror: true });
    expect(attachableIdentity(declared, true)).toEqual(declared);
    const mirrored = { version: "0.9.9", protocol: 22, terminal_attach: false, terminal_mirror: true };
    expect(attachableIdentity(mirrored, true)).toEqual(mirrored);
    expect(attachableIdentity(mirrored, false)).toEqual(mirrored);
  });

  it("attaches on herdr-core without a PTY host: its stream runs on the server's own hc connection", () => {
    const declared = { version: "0.1.14", protocol: 22, terminal_attach: true };
    expect(attachableIdentity(declared, false, true)).toEqual(declared);
    expect(attachableIdentity(declared, false, false)).toEqual({ ...declared, terminal_attach: false, terminal_mirror: true });
  });

  it("counts the sidecar as runnable only with both node and node-pty", () => {
    expect(sidecarAvailable({ node: () => true, pty: () => true })).toBe(true);
    expect(sidecarAvailable({ node: () => false, pty: () => true })).toBe(false);
    expect(sidecarAvailable({ node: () => true, pty: () => false })).toBe(false);
  });

  it("takes a node for Node only when it answers in time, is not Bun and is built for this server's architecture", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-sidecar-probe-"));
    const stand = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    try {
      expect(isRealNode(stand("node", `echo 22.23.2 ${process.arch}`))).toBe(true);
      expect(isRealNode(stand("old-node", `echo 16.20.2 ${process.arch}`))).toBe(false);
      // an x64 Node under Rosetta beside an arm64 server, or the other way round (#596 review)
      expect(isRealNode(stand("other-arch", `echo 22.23.2 ${process.arch === "x64" ? "arm64" : "x64"}`))).toBe(false);
      expect(isRealNode(stand("bun-as-node", "echo bun"))).toBe(false);
      expect(isRealNode(stand("broken", "exit 1"))).toBe(false);
      expect(isRealNode(join(dir, "absent"))).toBe(false);
      // a node that never answers is given up on, not waited for
      expect(isRealNode(stand("hung", "exec sleep 30"), process.env, 200)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("host detection", () => {
  /** a PC that answers sh with `shError` (or not at all) and PowerShell with `ps` */
  const pc = (shError: string | null, ps: string | Error): SshConnection => ({
    run: async (script: string) => {
      if (shError !== null) throw new Error(shError);
      // the sh probe, then the socket realpath
      return script.includes("uname") ? "Linux\nx86_64\n/home/u\n/home/u/.config\n/usr/bin/herdr\nbundle-ready\n" : "/home/u/.config/herdr/herdr.sock";
    },
    runPowerShell: async (script: string) => {
      if (ps instanceof Error) throw ps;
      return script.includes("XDG_CONFIG_HOME") ? ps.replace("AppData\\Roaming\n", "AppData\\Roaming\n\n") : ps;
    },
  } as unknown as SshConnection);
  const windowsAnswer = "Windows\nAMD64\nC:\\Users\\u\nC:\\Users\\u\\AppData\\Roaming\nC:\\Users\\u\\AppData\\Local\nC:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe\n";

  it("takes a PC that answers sh as Linux or macOS without asking PowerShell", async () => {
    const { host, inspection } = await detectHost(pc(null, new Error("never asked")));
    expect(host.kind).toBe("posix");
    expect(inspection).toMatchObject({ platform: "linux-x64", home: "/home/u", herdrPath: "/usr/bin/herdr", expectedSocket: "/home/u/.config/herdr/herdr.sock", bundleReady: true });
  });
  it("asks a PC whose cmd or PowerShell cannot find sh in PowerShell, and reads Windows paths", async () => {
    for (const shError of ["'sh' is not recognized as an internal or external command,\r\noperable program or batch file.", "sh : The term 'sh' is not recognized as a name of a cmdlet, function, script file, or executable program."]) {
      const { host, inspection } = await detectHost(pc(shError, windowsAnswer), "qa");
      expect(host.kind).toBe("windows");
      expect(inspection).toMatchObject({
        platform: "win32-x64", home: "C:\\Users\\u", herdrPath: "C:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe",
        expectedSocket: "C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock",
        runtimeDir: `C:\\Users\\u\\AppData\\Local\\herdr-web-ui\\remote-v${REMOTE_BUNDLE_VERSION}`, bundleReady: false,
      });
    }
  });
  it("uses Windows XDG_CONFIG_HOME when resolving the herdr socket", async () => {
    const scripts: string[] = [];
    const ssh = {
      run: async () => { throw new Error("Unexpected sh probe"); },
      runPowerShell: async (script: string) => {
        scripts.push(script);
        return script.includes("XDG_CONFIG_HOME")
          ? "Windows\nAMD64\nC:\\Users\\u\nC:\\Users\\u\\AppData\\Roaming\nC:\\Temp\\xdg\nC:\\Users\\u\\AppData\\Local\nC:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe\n"
          : windowsAnswer;
      },
    } as unknown as SshConnection;
    const { inspection } = await detectHost(ssh, "qa");
    // regression (fails on main): the inspection must read XDG_CONFIG_HOME and prefer it over APPDATA
    expect(scripts.some((script) => script.includes("$env:XDG_CONFIG_HOME"))).toBe(true);
    expect(inspection.expectedSocket).toBe("C:\\Temp\\xdg\\herdr\\sessions\\qa\\herdr.sock");
  });
  it("keeps the APPDATA field aligned when Windows XDG_CONFIG_HOME is blank", async () => {
    const answer = "Windows\nAMD64\nC:\\Users\\u\nC:\\Users\\u\\AppData\\Roaming\n\nC:\\Users\\u\\AppData\\Local\nC:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe\n";
    const ssh = {
      run: async () => { throw new Error("'sh' is not recognized as an internal or external command"); },
      runPowerShell: async (script: string) => script.includes("XDG_CONFIG_HOME") ? answer : windowsAnswer,
    } as unknown as SshConnection;
    const { inspection } = await detectHost(ssh, "qa");
    // control: the empty XDG line preserves APPDATA, LOCALAPPDATA and herdr field positions
    expect(inspection.expectedSocket).toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
    expect(inspection.herdrPath).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe");
  });
  it("uses Windows APPDATA when XDG_CONFIG_HOME is absent", async () => {
    const { inspection } = await detectHost(pc("'sh' is not recognized as an internal or external command", windowsAnswer), "qa");
    // control: the existing APPDATA fallback is unchanged
    expect(inspection.expectedSocket).toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });
  it("refuses a Windows PC that is not x64, by name", async () => {
    await expect(detectHost(pc("sh: not found", windowsAnswer.replace("AMD64", "ARM64")))).rejects.toThrow(UNSUPPORTED_HOST);
  });
  it("reports sh's own error for a PC that answers neither shell", async () => {
    await expect(detectHost(pc("ssh: connect to host pc port 22: Connection refused", new Error("Connection refused")))).rejects.toThrow("connect to host pc port 22");
  });
  it("reads PowerShell's words out of its CLIXML stderr", () => {
    const stderr = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>처음 사용하기 위해 모듈을 준비하는 중입니다.</AV></PR></MS></Obj><S S="Error">Another installation is in progress; retry shortly_x000D__x000A_</S><S S="Error">At line:4 char:1 &lt;x&gt;_x000D__x000A_</S></Objs>';
    expect(decodeClixml(stderr)).toBe("Another installation is in progress; retry shortly\nAt line:4 char:1 <x>");
    expect(decodeClixml("#< CLIXML\n<Objs><Obj S=\"progress\"/></Objs>")).toBe("PowerShell failed");
  });
  it("gives each herdr session its own bridge log, launcher and startup status on Windows", () => {
    expect(windowsBridgeFiles()).toEqual({ log: "bridge.log", launcher: "start-bridge.cmd", status: "bridge.startup" });
    expect(windowsBridgeFiles("web-qa")).toEqual({ log: "bridge-web-qa.log", launcher: "start-bridge-web-qa.cmd", status: "bridge-web-qa.startup" });
  });
  it("quotes for PowerShell with doubled single quotes only", () => {
    expect(psQuote("C:\\Users\\o'brien\\x")).toBe("'C:\\Users\\o''brien\\x'");
    // PowerShell ends a single-quoted literal at a curly quote too
    expect(psQuote("a\u2019; Write-Output injected; #")).toBe("'a\u2019\u2019; Write-Output injected; #'");
    expect(psQuote("\u2018\u201A\u201B")).toBe("'\u2018\u2018\u201A\u201A\u201B\u201B'");
    expect(() => psQuote("a\nb")).toThrow();
  });
});

// verify() runs inside a setup that needs a real SSH host. Here its SSH forward is a loopback
// relay, and the bridge is a real server whose herdr is absent, or a stand-in with a fixed answer.
describe("bridge verification failures", () => {
  const TOKEN = "a".repeat(64);
  const GENERIC = (status: number) => `Bridge verification failed (${status}). Reconnect after checking the remote bridge.`;
  const socketBefore = process.env["HERDR_SOCKET"];
  const stops: (() => void)[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (socketBefore === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = socketBefore;
  });
  const temp = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-bridge-verify-")); dirs.push(dir); return dir; };
  /** a bridge whose herdr socket is `socket` */
  function bridge(socket: string): number {
    process.env["HERDR_SOCKET"] = socket;
    const server = createServer({ port: 0, hostname: "127.0.0.1", token: TOKEN, stateDir: temp(), machines: false, registerBridge: false, tailscaleOwner: null });
    stops.push(() => server.stop());
    return server.port!;
  }
  /** a bridge that answers /api/bridge with one fixed response */
  function answering(status: number, body: string): number {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body, { status }) });
    stops.push(() => server.stop(true));
    return server.port!;
  }
  /** what the person adding the PC is told when verification of the bridge on `port` fails */
  async function told(port: number, socket = "/home/u/.config/herdr/herdr.sock"): Promise<string> {
    const manager = new MachineManager(temp(), {} as PushService, {} as CompletionTracker);
    stops.push(() => manager.stop());
    const ssh = { forward: async (local: number, remote: number) => {
      const relay = Bun.serve({ port: local, hostname: "127.0.0.1", fetch: (request) => fetch(`http://127.0.0.1:${remote}${new URL(request.url).pathname}`, { headers: request.headers }) });
      stops.push(() => relay.stop(true));
    } } as unknown as SshConnection;
    const descriptor: BridgeDescriptor = { port, token: TOKEN, pid: process.pid, socket_path: socket, bridge_protocol: 0, bundle_version: "" };
    const verify = (manager as unknown as { verify(ssh: SshConnection, descriptor: BridgeDescriptor, socket: string): Promise<unknown> }).verify.bind(manager);
    return verify(ssh, descriptor, socket).then(() => "verified", (error: Error) => error.message);
  }
  /** what verifying `fields` says when nothing answers at the end of the tunnel, and the arguments forward() got */
  async function unanswered(fields: Record<string, unknown>): Promise<{ told: string; forwards: unknown[][] }> {
    const manager = new MachineManager(temp(), {} as PushService, {} as CompletionTracker);
    stops.push(() => manager.stop());
    const forwards: unknown[][] = [];
    const ssh = { forward: async (...args: unknown[]) => { forwards.push(args.slice(1)); } } as unknown as SshConnection;
    const descriptor = { port: 18472, token: TOKEN, pid: process.pid, socket_path: "/s", bridge_protocol: 0, bundle_version: "", ...fields } as BridgeDescriptor;
    const verify = (manager as unknown as { verify(ssh: SshConnection, descriptor: BridgeDescriptor, socket: string): Promise<unknown> }).verify.bind(manager);
    const told = await verify(ssh, descriptor, "/s").then(() => "verified", (error: Error) => error.message);
    return { told, forwards };
  }

  // Evaluate the entrypoint's actual socket setup without starting its daemon.
  const entryLines = readFileSync(new URL("./remote-entry.ts", import.meta.url), "utf8").split("\n");
  const socketSetup = ["const herdrConfig =", "const session =", 'process.env["HERDR_SOCKET"] ='].map((prefix) => {
    const line = entryLines.find((line) => line.startsWith(prefix));
    if (!line) throw new Error("remote-entry socket setup was not found");
    return line;
  }).join("\n");
  const bridgeSocket = new Function("windows", "process", "join", "homedir", `${socketSetup}\nreturn process.env["HERDR_SOCKET"];`);

  for (const root of ["C:\\Temp\\xdg\\", "C:\\", "C:/Temp/xdg", "C:\\Temp\\xdg\\..\\config"]) {
    for (const session of ["qa", undefined]) {
      it(`connects the inspected Windows socket to its bridge for ${JSON.stringify(root)}, session ${session}`, async () => {
        const env = { XDG_CONFIG_HOME: root, APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: session };
        const socket = String(bridgeSocket(true, { env }, win32.join, () => "C:\\Users\\u"));
        const identity = { pid: process.pid, managed_remote: true, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, socket_path: socket, socket_id: "1:2", herdr: { protocol: 22 } };
        const port = answering(200, JSON.stringify(identity));
        const descriptor = { ...identity, port, token: TOKEN };
        const ssh = {
          run: async () => { throw new Error("'sh' is not recognized as an internal or external command"); },
          runPowerShell: async (script: string) => {
            if (script.includes("PROCESSOR_ARCHITECTURE")) return `Windows\nAMD64\nC:\\Users\\u\n${env.APPDATA}\n${root}\nC:\\Users\\u\\AppData\\Local\nC:\\Programs\\herdr.exe\n${JSON.stringify(descriptor)}\n`;
            if (script.includes("--version")) return "herdr 0.9.3";
            if (script.includes("Get-Process")) return "live";
            throw new Error("Unexpected remote mutation");
          },
          forward: async (local: number, remote: number) => {
            const relay = Bun.serve({ port: local, hostname: "127.0.0.1", fetch: (request) => fetch(`http://127.0.0.1:${remote}${new URL(request.url).pathname}`, { headers: request.headers }) });
            stops.push(() => relay.stop(true));
          },
        } as unknown as SshConnection;
        const { inspection } = await detectHost(ssh, session);
        expect(inspection.expectedSocket).toBe(socket);
        const manager = new MachineManager(temp(), {} as PushService, {} as CompletionTracker);
        stops.push(() => manager.stop());
        const runtime = { generation: 0, ssh, machine: { target: { destination: "pc", session } }, endpoint: undefined };
        const prepare = (manager as unknown as { prepare(runtime: unknown): Promise<void> }).prepare.bind(manager);
        await prepare(runtime);
        expect(runtime.endpoint).toMatchObject({ token: TOKEN });
      });
    }
  }

  for (const root of ["relative\\xdg", "C:xdg", "/Temp/xdg"]) {
    it(`rejects a Windows XDG root without a drive-absolute path: ${root}`, async () => {
      const ssh = {
        run: async () => { throw new Error("'sh' is not recognized as an internal or external command"); },
        runPowerShell: async () => `Windows\nAMD64\nC:\\Users\\u\nC:\\Users\\u\\AppData\\Roaming\n${root}\nC:\\Users\\u\\AppData\\Local\nC:\\Programs\\herdr.exe\n`,
      } as unknown as SshConnection;
      await expect(windowsHost.inspect(ssh)).rejects.toThrow("XDG_CONFIG_HOME");
    });
  }

  it("says herdr is not running when the bridge finds no socket", async () => {
    const dir = temp();
    const socket = join(dir, "herdr.sock");
    const port = bridge(socket);
    const response = await fetch(`http://127.0.0.1:${port}/api/bridge`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.json() as { error: { code: string; message: string } };
    expect({ status: response.status, code: body.error.code }).toEqual({ status: 404, code: "socket_missing" });
    expect(body.error.message).not.toContain(dir);
    const message = await told(port, socket);
    expect(message).toContain("herdr is not running");
    expect(message).not.toContain(dir);
  });

  it("says herdr is not answering when the socket is there without a daemon", async () => {
    const dir = temp();
    const socket = join(dir, "herdr.sock");
    writeFileSync(socket, "");
    const message = await told(bridge(socket), socket);
    expect(message).toContain("herdr is not answering");
    expect(message).not.toContain(dir);
  });

  it("reads a missing socket from the 500 an installed older bridge still answers", async () => {
    const old = JSON.stringify({ error: { code: "internal_error", message: "ENOENT: no such file or directory, stat '/home/u/.config/herdr/herdr.sock'" } });
    const message = await told(answering(500, old));
    expect(message).toContain("herdr is not running");
    expect(message).not.toContain("/home/u");
  });

  /** a bridge that answers /api/bridge with `value` as JSON of `total` bytes */
  function sized(status: number, value: unknown, total: number): { port: number; cancelled: Promise<void> } {
    let cancelled: Promise<void> = new Promise(() => {});
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { const body = padded(value, total); cancelled = body.cancelled; return new Response(body.stream, { status }); } });
    stops.push(() => server.stop(true));
    return { port: server.port!, get cancelled() { return cancelled; } };
  }

  it("bounds bridge errors without echoing secrets", async () => {
    const secret = { error: { code: "connect_failed", message: "fixture-secret-token http://127.0.0.1:1/private" } };
    // within its 8 KiB the known code is still read
    expect(await told(sized(500, secret, 8 * 1024).port)).toContain("herdr is not answering");
    const over = sized(500, secret, 8 * 1024 + 32 * MiB);
    const message = await told(over.port);
    expect(message).toBe(GENERIC(500));
    await within(over.cancelled);
  });

  it("caps the bridge identity without naming any of it", async () => {
    const socket = "/home/u/.config/herdr/herdr.sock";
    const identity = { pid: process.pid, managed_remote: true, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, socket_path: socket, socket_id: "1:2", herdr: { protocol: 22 } };
    expect(await told(sized(200, identity, 64 * 1024).port, socket)).toBe("verified");
    const over = sized(200, identity, 64 * 1024 + 32 * MiB);
    expect(await told(over.port, socket)).toBe(new RemoteResponseTooLarge().message);
    await within(over.cancelled);
    const malformed = await told(answering(200, `{"token":"fixture-secret-token","socket_path":"${socket}"`), socket);
    expect(malformed).toBe(new RemoteResponseInvalid().message);
    expect(malformed).not.toContain("fixture-secret");
  });

  it("keeps the status-only message for any other answer, without repeating its text", async () => {
    expect(await told(answering(500, JSON.stringify({ error: { code: "internal_error", message: "EACCES: permission denied, stat '/home/u/x'" } })))).toBe(GENERIC(500));
    expect(await told(answering(503, "<html>proxy</html>"))).toBe(GENERIC(503));
    expect(await told(answering(500, "null"))).toBe(GENERIC(500));
  });

  // #1960: an Ovis older than its loopback relay, with HOST set to another address, answers nothing on the PC's 127.0.0.1
  it("says what to change when nothing answers on the PC's loopback, not the connection's raw error", async () => {
    expect((await unanswered({})).told).toBe("This PC's Ovis does not answer at 127.0.0.1:18472 through SSH. If it runs with HOST set to another address, update it or set HOST=127.0.0.1 there, restart it, then add the PC again.");
    expect((await unanswered({ managed_remote: true })).told).toBe("The bridge on this PC does not answer at 127.0.0.1:18472 through SSH. Reconnect after checking the remote bridge.");
  });

  it("says a bridge that did not answer in time timed out, without HOST advice", async () => {
    const timedOut = spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    try {
      expect((await unanswered({})).told).toBe("This PC's Ovis did not answer at 127.0.0.1:18472 through SSH within 15 seconds. Reconnect after checking that it runs.");
    } finally { timedOut.mockRestore(); }
  });

  it("says a bridge that stops halfway through its answer timed out", async () => {
    // the deadline is what is tested: 200 ms here, not 15 s
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const short = spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(200));
    const manager = new MachineManager(temp(), {} as PushService, {} as CompletionTracker);
    stops.push(() => manager.stop());
    // its headers and the start of a body, then nothing
    const ssh = { forward: async (local: number) => {
      const stalled = Bun.listen({ hostname: "127.0.0.1", port: local, socket: { data(socket) { socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{\"pid\""); } } });
      stops.push(() => stalled.stop(true));
    } } as unknown as SshConnection;
    const descriptor = { port: 18472, token: TOKEN, pid: process.pid, socket_path: "/s", bridge_protocol: 0, bundle_version: "" } as BridgeDescriptor;
    const verify = (manager as unknown as { verify(ssh: SshConnection, descriptor: BridgeDescriptor, socket: string): Promise<unknown> }).verify.bind(manager);
    try {
      expect(await verify(ssh, descriptor, "/s").then(() => "verified", (error: Error) => error.message)).toBe("This PC's Ovis did not answer at 127.0.0.1:18472 through SSH within 15 seconds. Reconnect after checking that it runs.");
    } finally { short.mockRestore(); }
  });

  it("tunnels only to the PC's loopback, whatever address a descriptor names", async () => {
    expect((await unanswered({ host: "203.0.113.99" })).forwards).toEqual([[18472]]);
  });
});

// A crash can leave machines.json its old length in NULs (#2044): the app must still start.
describe("saved PCs that cannot be read", () => {
  const offline = async () => { throw new Error("local offline"); };
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const directory = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-machines-state-")); dirs.push(dir); return dir; };

  it("sets a file of NULs aside and starts without the PCs it held", () => {
    const dir = directory();
    const zeros = Buffer.alloc(353);
    writeFileSync(join(dir, "machines.json"), zeros);
    const error = spyOn(console, "error").mockImplementation(() => {});
    let manager: MachineManager | undefined;
    try {
      manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), offline);
      const aside = readdirSync(dir).filter((name) => name.startsWith("machines.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(aside[0]).not.toContain(":");
      expect(readFileSync(join(dir, aside[0]!))).toEqual(zeros);
      expect(existsSync(join(dir, "machines.json"))).toBe(false);
      expect(manager.list().map((machine) => machine.kind)).toEqual(["local"]);
      expect(manager.settings()).toEqual({ auto_update_bridges: true, set_aside: aside });
      expect(String(error.mock.calls[0]?.[0])).toContain(aside[0]!);
      // the next save makes a readable file again
      (manager as unknown as { persist(): void }).persist();
      expect(JSON.parse(readFileSync(join(dir, "machines.json"), "utf8"))).toEqual([]);
    } finally { manager?.stop(); error.mockRestore(); }
  });

  it("sets aside herdr's approvals that are not JSON, and says so with the PCs' settings", () => {
    const dir = directory();
    writeFileSync(join(dir, "herdr-profile-state.json"), Buffer.alloc(120));
    const error = spyOn(console, "error").mockImplementation(() => {});
    let manager: MachineManager | undefined;
    try {
      manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), offline);
      expect(manager.settings().set_aside).toEqual([expect.stringMatching(/^herdr-profile-state\.json\.corrupt-/)]);
    } finally { manager?.stop(); error.mockRestore(); }
  });

  it("writes an unchanged list again when its file was deleted or replaced on disk", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, JSON.stringify([{ id: "11111111-1111-1111-1111-111111111111", name: "Saved PC", target: { destination: "BuildBox" }, enabled: false, snapshot: null }]));
    const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), offline);
    try {
      const persist = () => (manager as unknown as { persist(): void }).persist();
      persist();
      const saved = readFileSync(path, "utf8");
      rmSync(path);
      persist();
      expect(readFileSync(path, "utf8")).toBe(saved);
      writeFileSync(path, "[]");
      persist();
      expect(readFileSync(path, "utf8")).toBe(saved);
      // the same length, other bytes
      writeFileSync(path, saved.replace("Saved PC", "Other PC"));
      persist();
      expect(readFileSync(path, "utf8")).toBe(saved);
    } finally { manager.stop(); }
  });

  it("still refuses to start on JSON that is not a list of PCs, leaving it in place", () => {
    const dir = directory();
    writeFileSync(join(dir, "machines.json"), "{}");
    expect(() => new MachineManager(dir, {} as PushService, new CompletionTracker(null), offline)).toThrow("Invalid machines.json");
    expect(readFileSync(join(dir, "machines.json"), "utf8")).toBe("{}");
    expect(readdirSync(dir).filter((name) => name.includes("corrupt"))).toEqual([]);
  });
});

describe("a Windows startup retried after a scheduler failure", () => {
  it("does not read the previous attempt's startup status as this one's", async () => {
    // Given a PC whose last start left a scheduler failure in its startup status file.
    const dir = mkdtempSync(join(tmpdir(), "herdr-windows-stale-status-"));
    const manager = new MachineManager(dir, {} as never, {} as never, async () => { throw new Error("fixture local offline"); });
    const runtime = manager["runtime"]({ id: "windows", name: "pc", kind: "ssh", enabled: true, state: "error", action_required: "windows_start_failed", target: { destination: "pc" }, snapshot: null, error: "Task registration denied" });
    manager["machines"].set("windows", runtime);
    const job = { public: { id: "review", machine_id: "windows", target: { destination: "pc" }, phase: "starting", step: "Starting", challenge: null, installations: [], error: null, ssh_output: null } as SetupJob, abort: new AbortController(), timer: setTimeout(() => {}, 600_000), update: false, auto: false, stageStartedAt: Date.now(), finished: Promise.resolve() };
    job.timer.unref();
    manager["jobs"].set(job.public.id, job);
    manager["wait"] = async () => "approved";
    const socket = "C:\\socket";
    const descriptor = { pid: 4242, port: 7317, token: "a".repeat(64), socket_path: socket, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
    let status: string | null = "interactive_failed: Task registration denied";
    let launched = false, registered = false, pauses = 0;
    runtime.ssh = {
      run: async () => { throw new Error("Windows has no sh"); },
      runPowerShell: async (script: string) => {
        // The remote registry: the launch script may clear the status before it starts the bridge.
        if (script.includes("Win32_Process")) {
          if (script.includes(`Remove-Item -LiteralPath "$dir\\${windowsBridgeFiles().status}"`)) status = null;
          launched = true;
          return "";
        }
        if (script.includes("-Filter *.json")) return registered ? JSON.stringify(descriptor) : "";
        if (script.includes("ReadAllText($status)")) return status ?? "";
        throw new Error("Unexpected remote script");
      },
      close() {},
    } as never;
    const mocks = [
      spyOn(windowsHost, "inspect").mockResolvedValue({ platform: "win32-x64", home: "C:\\Users\\u", herdrPath: "C:\\herdr.exe", expectedSocket: socket, bundleReady: true, bundleOlder: false, descriptors: [], runtimeDir: "C:\\runtime", registryDir: "C:\\registry" }),
      spyOn(windowsHost, "herdrVersion").mockResolvedValue("herdr 0.9.5"),
      spyOn(manager as never, "verify").mockResolvedValue({ endpoint: { url: "http://fixture", token: "fixture" }, identity: { ...descriptor, socket_id: "fixture-socket", herdr: { version: "0.9.5", protocol: 22 } } } as never),
      // The new bridge loads, clears any status itself and registers after the first poll.
      spyOn(Bun, "sleep").mockImplementation(async () => { if (launched) { status = null; registered = true; } }),
    ];
    manager["pause"] = async () => { if (++pauses >= 3) job.abort.abort(); };
    try {
      // When the user retries after fixing Task Scheduler.
      const outcome = await manager["prepare"](runtime, job).then(() => "connected", (error: Error) => error.message);
      // Then the new bridge connects instead of the old failure being shown again.
      expect(outcome).toBe("connected");
      expect(job.public.action_required).not.toBe("windows_start_failed");
    } finally {
      manager.stop(); clearTimeout(job.timer);
      for (const mock of mocks) mock.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
