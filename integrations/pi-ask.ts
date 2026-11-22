import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_ASK_BRIDGE_DIRECTORY,
  PI_ASK_BRIDGE_VERSION,
  PI_ASK_EVENTS,
  PI_ASK_SOCKET_PATH_MAX,
  PI_ASK_SUBMIT_TIMEOUT_MS,
  piAskOpenCalls,
  type PiAskBridgeState,
  type PiAskFlow,
  type PiAskSubmitReply,
  type PiBridgeCommand,
  type PiBridgeCommands,
} from "../shared/pi-ask-bridge.ts";

export interface PiEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export interface PiSessionContext {
  hasUI?: boolean;
  sessionManager?: { getSessionFile(): unknown; getBranch?(): unknown };
}

export interface PiExtensionAPI {
  events: PiEventBus;
  /** pi 1.3.0+: the commands `prompt` can run in this session, extension ones first */
  getCommands?(): unknown;
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: PiSessionContext) => unknown): void;
}

export interface PiAskBridgeOptions {
  events: PiEventBus;
  socketPath: string;
  pid?: number;
  platform?: NodeJS.Platform;
  submitTimeoutMs?: number;
  /** pi's own command list (`pi.getCommands()`), read at each request: a /reload changes it */
  commands?: () => unknown;
}

export interface PiAskBridge {
  start(context: PiSessionContext): Promise<void>;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

/** pi's own rule (config.js getAgentDir, utils/paths.js normalizePath): PI_CODING_AGENT_DIR with `~` and file: URLs expanded, else ~/.pi/agent. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env["PI_CODING_AGENT_DIR"];
  if (!dir) return join(home, ".pi", "agent");
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  return resolve(/^file:\/\//.test(dir) ? fileURLToPath(dir) : dir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSocket(path: string): boolean {
  try { return lstatSync(path).isSocket(); } catch { return false; }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { done(null); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => done(null));
  });
}

/** Nothing here reads or types into the terminal; a pi without a UI serves nothing. */
export function createPiAskBridge(options: PiAskBridgeOptions): PiAskBridge {
  const { events, socketPath } = options;
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  const submitTimeoutMs = options.submitTimeoutMs ?? PI_ASK_SUBMIT_TIMEOUT_MS;
  const flows = new Map<string, PiAskFlow>();
  let context: PiSessionContext | undefined;
  let server: Server | null = null;

  events.on(PI_ASK_EVENTS.started, (data) => {
    if (!isRecord(data) || data["version"] !== 1 || typeof data["flowId"] !== "string") return;
    const { version: _version, ...flow } = data;
    flows.set(data["flowId"], flow as unknown as PiAskFlow);
  });
  events.on(PI_ASK_EVENTS.completed, (data) => {
    if (isRecord(data) && typeof data["flowId"] === "string") flows.delete(data["flowId"]);
  });

  const sessionFile = (): string | null => {
    try {
      const file = context?.sessionManager?.getSessionFile();
      return typeof file === "string" && file.length > 0 ? file : null;
    } catch { return null; }
  };

  /** pi-ask's own rule, on the branch pi is on now: what it reopens on resume and what /tree changes. */
  const openCalls = (): string[] | null => {
    try {
      const branch = context?.sessionManager?.getBranch?.();
      return Array.isArray(branch) ? branch.reduce<string[]>(piAskOpenCalls, []) : null;
    } catch { return null; }
  };

  /** The extension commands in pi's list, or null when pi cannot say (it throws before its runtime is bound). */
  const extensionCommands = (): PiBridgeCommand[] | null => {
    try {
      const all = options.commands?.();
      if (!Array.isArray(all)) return null;
      return all.flatMap((command: unknown): PiBridgeCommand[] => {
        if (!isRecord(command) || command["source"] !== "extension" || typeof command["name"] !== "string") return [];
        const info = isRecord(command["sourceInfo"]) ? command["sourceInfo"] : {};
        return [{
          name: command["name"],
          ...(typeof command["description"] === "string" ? { description: command["description"] } : {}),
          ...(typeof info["scope"] === "string" ? { scope: info["scope"] } : {}),
          ...(typeof info["origin"] === "string" ? { origin: info["origin"] } : {}),
        }];
      });
    } catch { return null; }
  };

  const submit = async (body: unknown): Promise<{ status: number; reply: PiAskSubmitReply }> => {
    if (!isRecord(body) || typeof body["flowId"] !== "string" || typeof body["createdAt"] !== "number" || typeof body["sessionFile"] !== "string" || !isRecord(body["response"])) {
      return { status: 400, reply: { ok: false, error: "invalid_request", message: "flowId, createdAt, sessionFile and response are required." } };
    }
    const flowId = body["flowId"];
    // checked in the same turn as the emit below: pi-ask reopens a call's form under the same flowId,
    // and an answer read for one form must never reach the next
    if (flows.get(flowId)?.createdAt !== body["createdAt"] || sessionFile() !== body["sessionFile"]) {
      return { status: 200, reply: { ok: false, error: "flow_not_found", message: "Ask flow is not active." } };
    }
    const requestId = `herdr-web-ui-${randomUUID()}`;
    let stopListening = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<{ status: number; reply: PiAskSubmitReply }>((done) => {
      stopListening = events.on(PI_ASK_EVENTS.submitResult, (data) => {
        if (!isRecord(data) || data["requestId"] !== requestId) return;
        // pi-ask closed the form without a completed event (its component was disposed)
        if (data["error"] === "flow_not_found" && flows.get(flowId)?.createdAt === body["createdAt"]) flows.delete(flowId);
        done({
          status: 200,
          reply: data["ok"] === true
            ? { ok: true }
            : { ok: false, error: (["flow_not_found", "invalid_request", "invalid_answer"].includes(data["error"] as string) ? data["error"] : "invalid_request") as "invalid_request", message: typeof data["message"] === "string" ? data["message"] : "pi-ask refused the answer." },
        });
      });
      timer = setTimeout(() => done({ status: 504, reply: { ok: false, error: "timeout", message: "pi-ask did not confirm the answer." } }), submitTimeoutMs);
    });
    try {
      events.emit(PI_ASK_EVENTS.submit, { version: 1, requestId, flowId, response: body["response"] });
      return await settled;
    } finally {
      stopListening();
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.url === "/v1/state" && request.method === "GET") {
        send(response, 200, { version: PI_ASK_BRIDGE_VERSION, pid, sessionFile: sessionFile(), flows: [...flows.values()], openCalls: openCalls() } satisfies PiAskBridgeState);
        return;
      }
      if (request.url === "/v1/commands" && request.method === "GET") {
        send(response, 200, { version: PI_ASK_BRIDGE_VERSION, pid, commands: extensionCommands() } satisfies PiBridgeCommands);
        return;
      }
      if (request.url === "/v1/submit" && request.method === "POST") {
        const text = await readBody(request);
        let body: unknown = null;
        try { body = text === null ? null : JSON.parse(text); } catch {}
        const { status, reply } = await submit(body);
        send(response, status, reply);
        return;
      }
      send(response, 404, { ok: false, error: "not_found" });
    } catch {
      if (!response.headersSent) send(response, 500, { ok: false, error: "internal" });
    }
  };

  const removeSocket = (): void => {
    if (isSocket(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }
  };

  const start = async (next: PiSessionContext): Promise<void> => {
    if (next?.hasUI !== true) return;
    context = next;
    if (server !== null || platform === "win32" || Buffer.byteLength(socketPath) > PI_ASK_SOCKET_PATH_MAX) return;
    const directory = dirname(socketPath);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      chmodSync(directory, 0o700);
      // only this pid's socket: a crashed earlier process with the same pid left it, nobody listens
      removeSocket();
      const listening = createServer((request, response) => { void handle(request, response); });
      await new Promise<void>((done, fail) => {
        listening.once("error", fail);
        listening.listen(socketPath, () => { listening.off("error", fail); done(); });
      });
      chmodSync(socketPath, 0o600);
      listening.unref();
      server = listening;
    } catch {
      server = null;
    }
  };

  const stop = async (): Promise<void> => {
    const closing = server;
    server = null;
    context = undefined;
    flows.clear();
    if (closing === null) return;
    await new Promise<void>((done) => closing.close(() => done()));
    removeSocket();
  };

  return { start, stop };
}

export default function piAskBridgeExtension(pi: PiExtensionAPI): void {
  const bridge = createPiAskBridge({
    events: pi.events,
    socketPath: join(piAgentDir(), PI_ASK_BRIDGE_DIRECTORY, `${process.pid}.sock`),
    commands: () => pi.getCommands?.(),
  });
  pi.on("session_start", (_event, context) => bridge.start(context));
  pi.on("session_shutdown", () => bridge.stop());
}
