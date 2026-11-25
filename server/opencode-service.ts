import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenCodeServiceConfig {
  baseUrl: string;
  port: number;
  pid: number;
  password: string;
  /** the version service.json names (OpenCode 2.0.32 writes it), checked against /api/info */
  version?: string;
}

export interface OpenCodeFormFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface OpenCodeFormField {
  key: string;
  type: "string" | "multiselect" | string;
  title?: string;
  description?: string;
  required?: boolean;
  options?: OpenCodeFormFieldOption[];
  custom?: boolean;
}

export interface OpenCodeFormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: OpenCodeFormField[];
}

export function opencodeStateDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "opencode");
}

export function readOpenCodeService(stateDir?: string, env: Record<string, string | undefined> = process.env, home = homedir()): OpenCodeServiceConfig | null {
  const dir = stateDir ?? opencodeStateDir(env, home);
  const path = join(dir, "service.json");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const maxBytes = 65_536;
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= maxBytes; size += read) read = readSync(fd, buffer, size, buffer.length - size, null);
    if (size > maxBytes) return null;
    const raw = buffer.toString("utf8", 0, size);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { port, pid, password, url, version } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof password !== "string" || !password) return null;
    if (version !== undefined && (typeof version !== "string" || !version)) return null;
    try { process.kill(pid, 0); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") return null;
    }

    let baseUrl = "";
    let resolvedPort = 0;

    if (url !== undefined) {
      if (typeof url !== "string") return null;
      const u = new URL(url);
      if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password) return null;
      baseUrl = u.origin;
      resolvedPort = u.port ? Number(u.port) : 80;
    } else if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
      resolvedPort = port;
      baseUrl = `http://127.0.0.1:${port}`;
    }

    if (!baseUrl || resolvedPort <= 0) return null;
    return { baseUrl, port: resolvedPort, pid, password, ...(typeof version === "string" ? { version } : {}) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function opencodeAuthHeader(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

export const OPENCODE_HTTP_TIMEOUT_MS = 1_500;

/** node:http does not use Bun fetch's proxy environment, including on Bun 1.4.2. */
function openCodeRequest(config: OpenCodeServiceConfig, path: string, signal?: AbortSignal, body?: string, maxBytes = 1024 * 1024): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = request(new URL(path, config.baseUrl), {
      agent: false,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: opencodeAuthHeader(config.password),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.any([AbortSignal.timeout(OPENCODE_HTTP_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.once("error", () => resolve(null));
      response.once("aborted", () => resolve(null));
      // Destroy rather than drain a body we will not use, so it cannot hold the request open.
      if (body !== undefined || status < 200 || status >= 300) {
        resolve({ status, body: "" });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          resolve(null);
          response.destroy();
          req.destroy();
        } else chunks.push(chunk);
      });
      response.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", () => resolve(null));
    req.end(body);
  });
}

export async function listPendingQuestionForms(
  config: OpenCodeServiceConfig,
  sessionID: string,
  signal?: AbortSignal,
): Promise<OpenCodeFormInfo[] | null> {
  try {
    const response = await openCodeRequest(config, `/api/session/${encodeURIComponent(sessionID)}/form`, signal);
    if (!response || response.status < 200 || response.status >= 300) return null;
    const body = JSON.parse(response.body) as unknown;
    const items = Array.isArray(body)
      ? body
      : (typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : []);

    return items.filter((item): item is OpenCodeFormInfo => {
      if (typeof item !== "object" || item === null) return false;
      const { id, sessionID: formSession, title, metadata, fields } = item as Record<string, unknown>;
      if (typeof id !== "string" || formSession !== sessionID || typeof title !== "string" || !Array.isArray(fields) || fields.length > 64 || JSON.stringify(item).length > 65_536) return false;
      const keys = new Set<string>();
      for (const field of fields) {
        if (typeof field !== "object" || field === null || typeof field.key !== "string" || !field.key || keys.has(field.key)
          || !["string", "select", "multiselect"].includes(field.type)
          || (field.title !== undefined && typeof field.title !== "string")
          || (field.description !== undefined && typeof field.description !== "string")
          || (field.custom !== undefined && typeof field.custom !== "boolean")) return false;
        keys.add(field.key);
        if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((option: unknown) =>
          typeof option !== "object" || option === null || !("value" in option) || typeof option.value !== "string"
          || !("label" in option) || typeof option.label !== "string"
          || ("description" in option && typeof option.description !== "string")))) return false;
      }
      const meta = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : undefined;
      return meta?.kind === "question";
    });
  } catch {
    return null;
  }
}

const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

async function getJson(config: OpenCodeServiceConfig, path: string, signal?: AbortSignal, maxBytes?: number): Promise<unknown> {
  const response = await openCodeRequest(config, path, signal, undefined, maxBytes);
  if (!response || response.status < 200 || response.status >= 300) return undefined;
  try { return JSON.parse(response.body) as unknown; } catch { return undefined; }
}

/**
 * The version of the process that answers at the service's URL, only when that process is the one
 * service.json names: the same pid and, where the file records one, the same version. Anything else
 * (a reused port, a stale file, a second service) is no service; nothing is ever started here.
 */
export async function verifyOpenCodeService(config: OpenCodeServiceConfig, signal?: AbortSignal): Promise<string | null> {
  const info = object(await getJson(config, "/api/info", signal));
  if (!info || info.pid !== config.pid || typeof info.version !== "string" || !info.version) return null;
  if (config.version !== undefined && info.version !== config.version) return null;
  return info.version;
}

export interface OpenCodeService { config: OpenCodeServiceConfig; version: string }

const VERIFIED_MS = 5_000;
let verified: { key: string; until: number; service: OpenCodeService } | null = null;

export const openCodeServiceOptions: { stateDir?: string } = {};

export async function openCodeService(stateDir?: string, signal?: AbortSignal, { onWindows = false }: { onWindows?: boolean } = {}): Promise<OpenCodeService | null> {
  if (process.platform === "win32" && !onWindows) return null;
  const config = serviceFile(stateDir ?? openCodeServiceOptions.stateDir ?? opencodeStateDir());
  if (!config) return null;
  const key = JSON.stringify(config);
  if (verified?.key === key && verified.until > Date.now()) return verified.service;
  const version = await verifyOpenCodeService(config, signal);
  if (!version) return null;
  verified = { key, until: Date.now() + VERIFIED_MS, service: { config, version } };
  return verified.service;
}

const files = new Map<string, { stamp: string; config: OpenCodeServiceConfig | null }>();

function serviceFile(stateDir: string): OpenCodeServiceConfig | null {
  const path = join(stateDir, "service.json");
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch { files.delete(path); return null; }
  const known = files.get(path);
  if (known?.stamp === stamp) return known.config;
  const config = readOpenCodeService(stateDir);
  files.delete(path);
  files.set(path, { stamp, config });
  if (files.size > 16) files.delete(files.keys().next().value!);
  return config;
}

/**
 * The OpenCode version its service file names (OpenCode 2.0.32 writes one), unverified: enough to pick
 * the form its skills are typed in before any pane runs it, never to trust the service with.
 */
export function openCodeInstalledVersion(stateDir?: string): string | null {
  return readOpenCodeService(stateDir ?? openCodeServiceOptions.stateDir)?.version ?? null;
}

/**
 * "2" when the pane's OpenCode runs with a flag only OpenCode 2 has: `--standalone` (a private server) and
 * `--server <url>` start a TUI without the background service, so no service file names its version
 * (#1551). Read from herdr's process info, nothing spawned; a major alone verifies no pin. Words after
 * `--` are operands (a directory named `--standalone`), not flags.
 */
export function openCodeFlagVersion(argv: unknown): string | null {
  if (!Array.isArray(argv)) return null;
  const end = argv.indexOf("--");
  const flags = argv.slice(1, end === -1 ? undefined : end);
  return flags.some((word) => word === "--standalone" || word === "--server" || (typeof word === "string" && word.startsWith("--server="))) ? "2" : null;
}

export function forgetOpenCodeService(): void {
  verified = null;
}

/** Whether the service holds this session: a TUI bound to another service (or none) answers no. */
export async function openCodeHasSession(config: OpenCodeServiceConfig, sessionID: string, signal?: AbortSignal): Promise<boolean> {
  const session = object(await getJson(config, `/api/session/${encodeURIComponent(sessionID)}`, signal));
  return object(session?.data)?.id === sessionID;
}

export interface OpenCodeCommandInfo { name: string; description?: string }
export interface OpenCodeSkillInfo { id: string; name: string; description?: string; path: string }

const locationQuery = (directory: string): string => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

function listed(body: unknown, directory: string): unknown[] | null {
  const envelope = object(body);
  if (!envelope || !Array.isArray(envelope.data) || object(envelope.location)?.directory !== directory) return null;
  return envelope.data;
}

/**
 * GET /api/command and /api/skill for one directory (pinned OpenAPI at 843a6c51). A location the
 * service has not loaded yet answers empty lists at first; the bundled skills are never absent from
 * a loaded one, so an empty skill list is no answer rather than "no skills".
 */
export async function listOpenCodeCatalog(config: OpenCodeServiceConfig, directory: string, signal?: AbortSignal): Promise<{ commands: OpenCodeCommandInfo[]; skills: OpenCodeSkillInfo[] } | null> {
  const [commandBody, skillBody] = await Promise.all([
    getJson(config, `/api/command?${locationQuery(directory)}`, signal),
    getJson(config, `/api/skill?${locationQuery(directory)}`, signal, 8 * 1024 * 1024),
  ]);
  const commandItems = listed(commandBody, directory);
  const skillItems = listed(skillBody, directory);
  if (!commandItems || !skillItems || skillItems.length === 0) return null;
  const commands = commandItems.flatMap((item): OpenCodeCommandInfo[] => {
    const row = object(item);
    if (!row || typeof row.name !== "string" || !row.name || (row.description !== undefined && typeof row.description !== "string")) return [];
    return [{ name: row.name, ...(typeof row.description === "string" ? { description: row.description } : {}) }];
  });
  const skills = skillItems.flatMap((item): OpenCodeSkillInfo[] => {
    const row = object(item);
    if (!row || typeof row.id !== "string" || !/^\S+$/u.test(row.id) || typeof row.name !== "string" || typeof row.path !== "string"
      || (row.description !== undefined && typeof row.description !== "string")) return [];
    return [{ id: row.id, name: row.name, path: row.path, ...(typeof row.description === "string" ? { description: row.description } : {}) }];
  });
  return { commands, skills };
}

export interface OpenCodeEvent {
  type: string;
  created?: number;
  directory?: string;
  data: Record<string, unknown>;
}

/** One SSE block of GET /api/event (`data: {json}` lines; `:` heartbeats), or null. */
export function parseOpenCodeEvent(block: string): OpenCodeEvent | null {
  const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
  if (!data) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  const event = object(parsed);
  if (!event || typeof event.type !== "string") return null;
  const directory = object(event.location)?.directory;
  return {
    type: event.type, data: object(event.data) ?? {},
    ...(typeof event.created === "number" && Number.isFinite(event.created) ? { created: event.created } : {}),
    ...(typeof directory === "string" ? { directory } : {}),
  };
}

/**
 * GET /api/event, volatile by contract: events missed while it was down are gone, so `onOpen`
 * tells the caller to re-read what it cached.
 */
export function subscribeOpenCodeEvents(config: OpenCodeServiceConfig, handlers: { onOpen(): void; onEvent(event: OpenCodeEvent): void; onClose(): void }): { close(): void } {
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: ReturnType<typeof request> | undefined;
  const connect = (): void => {
    if (closed) return;
    let open = false;
    const lost = (): void => {
      if (current !== req) return;
      current = undefined;
      if (open) handlers.onClose();
      if (closed) return;
      timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)));
      timer.unref?.();
    };
    const req = request(new URL("/api/event", config.baseUrl), {
      agent: false, method: "GET", headers: { Authorization: opencodeAuthHeader(config.password), Accept: "text/event-stream" },
    }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); req.destroy(); lost(); return; }
      open = true;
      attempt = 0;
      handlers.onOpen();
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) { req.destroy(); return; }
        for (let end = buffer.search(/\r?\n\r?\n/u); end >= 0; end = buffer.search(/\r?\n\r?\n/u)) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end).replace(/^\r?\n\r?\n/u, "");
          const event = parseOpenCodeEvent(block);
          if (event) handlers.onEvent(event);
        }
      });
      response.once("end", lost);
      response.once("error", lost);
      response.once("aborted", lost);
    });
    current = req;
    req.on("socket", (socket) => socket.unref());
    req.once("error", lost);
    req.end();
  };
  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      const req = current;
      current = undefined;
      req?.destroy();
    },
  };
}

/** A reply's status: 0 when none came back, so the reply may or may not have landed. */
async function reply(config: OpenCodeServiceConfig, path: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await openCodeRequest(config, path, signal, JSON.stringify(payload));
    const status = response?.status ?? 0;
    return { ok: status === 200 || status === 204, status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * What became of a command sent through OpenCode's API: its status; `unsent` when the connection never opened, so
 * nothing reached OpenCode; `unknown` when it opened and no answer came back, so it may have run.
 */
export type OpenCodeCommandAnswer = { status: number } | "unsent" | "unknown";

/** Longer than a read's: a command's callback runs before its answer (session.ts command handler at 2.2.2). */
const OPENCODE_COMMAND_TIMEOUT_MS = 5_000;

/** `mayWrite` is asked once the connection is open, right before the request's bytes go; false sends nothing. */
function postCommand(config: OpenCodeServiceConfig, path: string, payload: unknown, mayWrite: () => boolean): Promise<OpenCodeCommandAnswer> {
  return new Promise((resolve) => {
    let connected = false;
    const req = request(new URL(path, config.baseUrl), {
      agent: false,
      method: "POST",
      headers: { Authorization: opencodeAuthHeader(config.password), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OPENCODE_COMMAND_TIMEOUT_MS),
    }, (response) => {
      resolve({ status: response.statusCode ?? 0 });
      response.destroy();
    });
    const write = (): void => {
      if (!mayWrite()) { resolve("unsent"); req.destroy(); return; }
      connected = true;
      req.end(JSON.stringify(payload));
    };
    req.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", write);
      else write();
    });
    req.once("error", () => resolve(connected ? "unknown" : "unsent"));
  });
}

/** A server command (`GET /api/command`) run in the session as the TUI's Enter runs it: `POST J/command`, steered (prompt/index.tsx at 2.2.2). */
export function runOpenCodeCommand(config: OpenCodeServiceConfig, sessionID: string, name: string, text: string, mayWrite: () => boolean): Promise<OpenCodeCommandAnswer> {
  return postCommand(config, `/api/session/${encodeURIComponent(sessionID)}/command`, { name, text, delivery: "steer" }, mayWrite);
}

/** The TUI's `/compact`: `POST J/compact`, answered once the compaction is admitted, not done (routes/session/index.tsx at 2.2.2). */
export function compactOpenCodeSession(config: OpenCodeServiceConfig, sessionID: string, mayWrite: () => boolean): Promise<OpenCodeCommandAnswer> {
  return postCommand(config, `/api/session/${encodeURIComponent(sessionID)}/compact`, {}, mayWrite);
}

export function replyOpenCodeForm(
  config: OpenCodeServiceConfig,
  sessionID: string,
  formID: string,
  answers: Record<string, string | string[]>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  return reply(config, `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, { answer: answers }, signal);
}

/** A request OpenCode 2's permission service holds for a session's tool call, waiting on its user (Permission.Request at 2.2.2). */
export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  /** `shell`, `edit`, `webfetch`, `external_directory`, an MCP tool's `<server>_<tool>`, ... */
  action: string;
  /** what it asks for: the command, the file, the URL (`*` for an MCP tool) */
  resources: string[];
  /** the patterns Always allow saves for the project; absent or empty, OpenCode offers no Always allow */
  save?: string[];
  /** `files[].patch` for an edit, `url` for a webfetch, `input` for an MCP tool */
  metadata?: Record<string, unknown>;
  /** the tool call that asks: its assistant message and call id */
  source?: { messageID: string; callID: string };
  /** that call's input, read from its message (withShellInput) */
  input?: Record<string, unknown>;
}

export type OpenCodePermissionDecision = "once" | "always" | "reject";

/** The permission routes are experimental in OpenCode 2's OpenAPI: only a verified 2.x.y service is asked, or answered. */
export const openCodePermissionsRead = (version: string): boolean => /^2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version);

/**
 * GET /api/session/{id}/permission: the requests the session waits on, oldest first. The route is experimental in
 * OpenCode's OpenAPI, so a list holding anything of another shape, or of another session, is no answer (null): those
 * requests stay with the terminal, as before the route was read.
 */
export async function listPendingPermissions(config: OpenCodeServiceConfig, sessionID: string, signal?: AbortSignal): Promise<OpenCodePermissionRequest[] | null> {
  const body = object(await getJson(config, `/api/session/${encodeURIComponent(sessionID)}/permission`, signal));
  if (!body || !Array.isArray(body.data)) return null;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string");
  const requests: OpenCodePermissionRequest[] = [];
  for (const item of body.data) {
    const row = object(item);
    if (!row || typeof row.id !== "string" || !row.id.startsWith("per") || row.sessionID !== sessionID || typeof row.action !== "string" || !row.action
      || !strings(row.resources) || (row.save !== undefined && !strings(row.save)) || (row.metadata !== undefined && !object(row.metadata))) return null;
    const source = object(row.source);
    requests.push({
      id: row.id, sessionID, action: row.action, resources: row.resources,
      ...(row.save === undefined ? {} : { save: row.save }), ...(row.metadata === undefined ? {} : { metadata: object(row.metadata)! }),
      ...(source?.type === "tool" && typeof source.messageID === "string" && source.messageID && typeof source.id === "string" && source.id
        ? { source: { messageID: source.messageID, callID: source.id } } : {}),
    });
  }
  return requests;
}

/**
 * GET /api/session/{id}/message/{messageID}: the input of the tool call a request names, as OpenCode's TUI reads it
 * (`source` → the assistant message's tool part, unless its input is still streaming), or null. The message holds the
 * turn's earlier tool output too, so it may be large.
 */
export async function readOpenCodeToolInput(config: OpenCodeServiceConfig, sessionID: string, { messageID, callID }: { messageID: string; callID: string }, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const message = object(object(await getJson(config, `/api/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`, signal, 8 * 1024 * 1024))?.data);
  if (message?.type !== "assistant" || message.id !== messageID || !Array.isArray(message.content)) return null;
  const call = message.content.map(object).find((part) => part?.type === "tool" && part.id === callID);
  const state = object(call?.state);
  return state && state.status !== "streaming" ? object(state.input) : null;
}

/**
 * The requests with the first one's command read from its call when it is a shell request: `resources` holds what the
 * permission rules match, pieces of the command (`a && b >> f` comes as `a` and `b`), so only the call's input says
 * what runs. A later read of the same request, naming the same call, reuses the input: a running call's input does not
 * change.
 */
export async function withShellInput(config: OpenCodeServiceConfig, requests: OpenCodePermissionRequest[] | null, known: readonly OpenCodePermissionRequest[] | null | undefined, signal?: AbortSignal): Promise<OpenCodePermissionRequest[] | null> {
  const first = requests?.[0];
  if (!requests || !first || first.action !== "shell" || !first.source) return requests;
  const { messageID, callID } = first.source;
  const input = known?.find((request) => request.id === first.id && request.sessionID === first.sessionID
    && request.source?.messageID === messageID && request.source.callID === callID)?.input
    ?? await readOpenCodeToolInput(config, first.sessionID, first.source, signal);
  return input ? [{ ...first, input }, ...requests.slice(1)] : requests;
}

/** POST /api/session/{id}/permission/{requestID}/reply: 204 once OpenCode took it, 404 when it no longer holds the request. */
export function replyOpenCodePermission(config: OpenCodeServiceConfig, sessionID: string, requestID: string, decision: OpenCodePermissionDecision, signal?: AbortSignal): Promise<{ ok: boolean; status: number }> {
  return reply(config, `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, { decision }, signal);
}
