/**
 * What an OpenCode v2 pane's own service says, read only from a service that already runs and that
 * /api/info proves is the one service.json names (never started or ensured here): the command and
 * skill rows for the pane's directory, the skill-activation and turn-completion events of the
 * pane's exact session, which settle a Chat send's outcome as native evidence (and, for the TUI's own
 * /compact, the compaction it asked for), and the permission
 * events that tell a prompt watch to read the pane's requests again.
 */
import type { HerdrPane, SlashCommand } from "../shared/protocol.ts";
import { resolveAgent, typingRoots } from "./pane-context.ts";
import { paneProcessRoots } from "./conversation.ts";
import { CATALOG_SOURCE_BUDGET_MS, registerCatalogSource } from "./catalog-sources.ts";
import { builtinCommands, cachedPaneCommands } from "./commands.ts";
import { opencodeSessionId } from "./opencode.ts";
import { listOpenCodeCatalog, openCodeHasSession, openCodeService, subscribeOpenCodeEvents, type OpenCodeEvent, type OpenCodeService } from "./opencode-service.ts";
import { skillTokens, type PromptPiece } from "./opencode-skill-attach.ts";
import { AGENT_SOURCES } from "./skills/index.ts";
import { commandSendFrom, noteCommandEvidence } from "./prompt.ts";
import type { CommandSend } from "./outcome.ts";

type Stream = { key: string; connected: boolean; close(): void };
let stream: Stream | null = null;
const catalogs = new Map<string, SlashCommand[]>();
const CATALOG_MAX = 64;

/**
 * One Chat send followed through its session's events. OpenCode 2.0.32 announces the user message
 * itself: `session.inbox.enqueued` carries its text and the skills attached to it (an attached skill
 * emits no `session.skill.activated`; live-checked on 2.0.32), `session.inbox.delivered` hands it to
 * an execution, and `session.execution.succeeded` ends that execution.
 */
interface Watch {
  paneId: string; sessionID: string; at: number;
  sendId?: string; texts?: ReadonlySet<string>; skills?: ReadonlySet<string>;
  /** a /compact the TUI runs itself, enqueuing no message of its text: its result is the compaction it started */
  compact?: { inputID?: string };
  early: OpenCodeEvent[]; inboxID?: string; delivered: boolean;
  verified: boolean;
}
const watches: Watch[] = [];
const WATCH_MS = 10 * 60_000;
const WATCH_MAX = 64;
const EARLY_MAX = 256;
export const PANE_VERIFIED_MS = 5_000;
/**
 * The panes that keep the shared event stream open: each verified to run OpenCode v2 on the stream's
 * service with its session there. A pane's end, its agent changing, or a verification that now fails
 * releases it; the stream closes when no verified pane uses its service.
 */
const verifiedPanes = new Map<string, { sessionID: string; key: string; until: number; generation: number; pid: number | null; started: number }>();
let verificationGeneration = 0;
export function openCodeVerificationCheckpoint(): number { return verificationGeneration; }
/** A cancelled verification opens no stream and caches nothing. */
type Verification = { cancelled: boolean; started: number };
const inFlight = new Set<Verification>();
const inFlightByPane = new Map<string, Set<Verification>>();
const paneTrackers = new Map<(paneId: string) => void, { handed: Set<string>; refresh: () => void }>();
function handOver(track: (paneId: string) => void, handed: Set<string>, paneId: string): void {
  if (handed.has(paneId)) return;
  handed.add(paneId);
  track(paneId);
}

/**
 * herdr can change a pane's agent without a status event or a lifecycle frame (0.9.3 on a loaded host: OpenCode
 * gone, the shell idle in front, and nothing said for its pane), so no snapshot would read it until the collector's
 * backstop. While panes hold the stream, each one's collectors read it again whenever its verification is due
 * (PANE_VERIFIED_MS): what that snapshot shows releases it as any other (server/core/status.ts, onReconciled).
 * Each collector is only asked to read again: tracking a pane anew would make every snapshot already on its
 * way older than the pane, so on a host where a read outlasts the recheck a pane gone would never be ended.
 */
let recheck: ReturnType<typeof setInterval> | null = null;
function scheduleRecheck(): void {
  if (recheck !== null) return;
  recheck = setInterval(() => {
    if (verifiedPanes.size === 0) { stopRecheck(); return; }
    for (const { refresh } of paneTrackers.values()) refresh();
  }, PANE_VERIFIED_MS);
  recheck.unref?.();
}
function stopRecheck(): void {
  if (recheck !== null) clearInterval(recheck);
  recheck = null;
}

export function trackVerifiedOpenCodePanes(track: (paneId: string) => void, refresh: () => void): () => void {
  const handed = new Set<string>();
  paneTrackers.set(track, { handed, refresh });
  for (const paneId of verifiedPanes.keys()) handOver(track, handed, paneId);
  return () => { paneTrackers.delete(track); };
}

const lineEnds = (text: string): string => text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
/**
 * The prompt texts OpenCode 2.0.32 stores for these pieces. Its TUI sends the prompt's own text
 * (packages/tui/src/component/prompt/index.tsx at 843a6c51, submitInner: `trim()` only decides
 * emptiness, `text: inputText`) and core keeps it (session/prompt.ts, `text: input.text`). Only a
 * paste is changed: line ends become \n (onPaste, pasteInputText), and unless the user's config sets
 * `prompt.paste: "full"` a paste of 3+ lines or 150+ characters is kept trimmed, behind a
 * placeholder followed by one space, and expanded back at submit (pasteInputText, pasteText,
 * expandTrackedPastedText). Both forms are expected; nothing else is normalized.
 */
export function openCodePromptTexts(prompt: readonly PromptPiece[]): Set<string> {
  const full = prompt.map((piece) => "typed" in piece ? piece.typed : lineEnds(piece.pasted)).join("");
  const collapsed = prompt.map((piece) => {
    if ("typed" in piece) return piece.typed;
    const text = lineEnds(piece.pasted);
    const content = text.trim();
    return (content.match(/\n/gu)?.length ?? 0) + 1 >= 3 || content.length > 150 ? `${content} ` : text;
  }).join("");
  return new Set([full, collapsed]);
}

function enqueuedMessage(data: Record<string, unknown>): { inboxID: string; text: string; skills: Set<string> } | null {
  const item = typeof data.item === "object" && data.item !== null ? data.item as Record<string, unknown> : null;
  const payload = item && typeof item.payload === "object" && item.payload !== null ? item.payload as Record<string, unknown> : null;
  if (item?.type !== "user" || typeof data.inboxID !== "string" || typeof payload?.text !== "string") return null;
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  return {
    inboxID: data.inboxID, text: payload.text,
    skills: new Set(skills.flatMap((skill) => typeof skill === "object" && skill !== null && typeof (skill as Record<string, unknown>).id === "string" ? [(skill as Record<string, unknown>).id as string] : [])),
  };
}

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => left.size === right.size && [...left].every((item) => right.has(item));

function step(watch: Watch, event: OpenCodeEvent): void {
  if (watch.compact !== undefined) compactStep(watch, watch.compact, event);
  else if (event.type === "session.inbox.enqueued" && watch.inboxID === undefined) {
    const message = enqueuedMessage(event.data);
    if (message && watch.texts!.has(message.text) && sameSet(message.skills, watch.skills!)) watch.inboxID = message.inboxID;
  } else if (event.type === "session.inbox.delivered" && watch.inboxID !== undefined && event.data.inboxID === watch.inboxID) watch.delivered = true;
  else if (event.type === "session.execution.succeeded" && watch.delivered) {
    watches.splice(watches.indexOf(watch), 1);
    noteCommandEvidence(watch.paneId, watch.sendId!, { kind: "native", at: event.created! });
  } else if ((event.type === "session.execution.failed" || event.type === "session.execution.interrupted") && watch.delivered) {
    watches.splice(watches.indexOf(watch), 1);
  }
}

/**
 * A /compact's own compaction, as recorded on 2.2.2 (server/fixtures/opencode-result-events-2.2.2.json): the first
 * `session.compaction.started` the user asked for (`reason: "manual"`) after the send names its input, a failure of that
 * input drops the watch, and the `session.compaction.ended` that follows it, which names no input, is the result. A
 * compaction begun before the send (an earlier /compact still running) or by OpenCode itself (`auto`) is not this one.
 */
function compactStep(watch: Watch, compact: { inputID?: string }, event: OpenCodeEvent): void {
  if (event.data.reason !== "manual") return;
  if (event.type === "session.compaction.started" && compact.inputID === undefined && typeof event.data.inputID === "string") compact.inputID = event.data.inputID;
  else if (event.type === "session.compaction.failed" && compact.inputID !== undefined && event.data.inputID === compact.inputID) watches.splice(watches.indexOf(watch), 1);
  else if (event.type === "session.compaction.ended" && compact.inputID !== undefined) {
    watches.splice(watches.indexOf(watch), 1);
    noteCommandEvidence(watch.paneId, watch.sendId!, { kind: "native", at: event.created! });
  }
}

function onEvent(event: OpenCodeEvent): void {
  if (event.type === "command.updated" || event.type === "skill.updated") { catalogs.clear(); return; }
  const sessionID = event.data.sessionID;
  if (typeof sessionID !== "string" || event.created === undefined) return;
  for (const watch of [...watches]) {
    if (watch.sessionID !== sessionID || event.created <= watch.at || !watches.includes(watch)) continue;
    if (watch.sendId === undefined || !watch.verified) { if (watch.early.length < EARLY_MAX) watch.early.push(event); }
    else step(watch, event);
  }
}

/**
 * Told the verified panes whose permission requests changed: `permission.asked` and `permission.replied` (recorded on
 * 2.2.2, server/fixtures/opencode-permission-2.2.2.json) name the session. Each stream's open names every pane on it,
 * as events missed while it was down are gone. Only a wake: the listener reads the requests again from the service.
 */
const permissionListeners = new Set<(paneId: string) => void>();
const PERMISSION_EVENTS = new Set(["permission.asked", "permission.replied"]);

export function onOpenCodePermissionChange(listener: (paneId: string) => void): () => void {
  permissionListeners.add(listener);
  return () => { permissionListeners.delete(listener); };
}

function wakePanes(key: string, sessionID?: string): void {
  for (const [paneId, entry] of verifiedPanes) {
    if (entry.key !== key || (sessionID !== undefined && entry.sessionID !== sessionID)) continue;
    for (const listener of permissionListeners) listener(paneId);
  }
}

function ensureStream(service: OpenCodeService): Stream {
  const key = JSON.stringify(service.config);
  if (stream?.key === key) return stream;
  stream?.close();
  stream = null;
  catalogs.clear();
  for (const [paneId, entry] of verifiedPanes) if (entry.key !== key) verifiedPanes.delete(paneId);
  const next: Stream = { key, connected: false, close: () => {} };
  const subscription = subscribeOpenCodeEvents(service.config, {
    onOpen: () => { catalogs.clear(); next.connected = true; if (stream === next) wakePanes(key); },
    onClose: () => {
      catalogs.clear();
      next.connected = false;
      // a compaction's end may have gone by while the stream was down: a later one is not this send's
      for (let index = watches.length - 1; index >= 0; index--) if (watches[index]!.compact !== undefined) watches.splice(index, 1);
    },
    onEvent: (event) => {
      onEvent(event);
      const sessionID = event.data.sessionID;
      if (stream === next && PERMISSION_EVENTS.has(event.type) && typeof sessionID === "string") wakePanes(key, sessionID);
    },
  });
  next.close = () => subscription.close();
  stream = next;
  return next;
}

let holders = 0;
let released = false;

export function holdOpenCodeNative(): () => void {
  holders += 1;
  released = false;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holders -= 1;
    if (holders > 0) return;
    closeOpenCodeNative();
    released = true;
  };
}

export function closeOpenCodeNative(): void {
  released = false;
  for (const verification of inFlight) verification.cancelled = true;
  inFlight.clear();
  inFlightByPane.clear();
  for (const { handed } of paneTrackers.values()) handed.clear();
  stream?.close();
  stream = null;
  catalogs.clear();
  watches.length = 0;
  verifiedPanes.clear();
  stopRecheck();
}

export function releaseOpenCodePane(paneId: string, checkpoint = Infinity): void {
  if ((verifiedPanes.get(paneId)?.generation ?? 0) > checkpoint) return;
  for (const verification of inFlightByPane.get(paneId) ?? []) if (verification.started > checkpoint) return;
  for (const verification of inFlightByPane.get(paneId) ?? []) { verification.cancelled = true; inFlight.delete(verification); }
  inFlightByPane.delete(paneId);
  for (const { handed } of paneTrackers.values()) handed.delete(paneId);
  verifiedPanes.delete(paneId);
  if (verifiedPanes.size === 0) stopRecheck();
  for (let index = watches.length - 1; index >= 0; index--) if (watches[index]!.paneId === paneId) watches.splice(index, 1);
  if (stream && ![...verifiedPanes.values()].some((entry) => entry.key === stream!.key)) {
    stream.close();
    stream = null;
    catalogs.clear();
  }
}

export function openCodeNativeState(): { stream: boolean; panes: string[] } {
  return { stream: stream !== null, panes: [...verifiedPanes.keys()] };
}

/** The OpenCode process a verified pane was last verified with, as herdr named it in front; null when unknown. */
export function openCodePanePid(paneId: string): number | null {
  return verifiedPanes.get(paneId)?.pid ?? null;
}

/** The verified service a pane's exact session lives in, or null (scan rows and screen paths stay). */
export async function openCodePaneService(pane: Pick<HerdrPane, "agent" | "agent_session"> & { pane_id?: string }, signal?: AbortSignal, stateDir?: string): Promise<{ service: OpenCodeService; sessionID: string } | null> {
  const label = resolveAgent(pane).agent;
  if (label !== "opencode") return null;
  const paneId = pane.pane_id;
  const verification: Verification = { cancelled: false, started: ++verificationGeneration };
  inFlight.add(verification);
  if (paneId !== undefined) {
    const own = inFlightByPane.get(paneId) ?? new Set<Verification>();
    own.add(verification);
    inFlightByPane.set(paneId, own);
  }
  let held: boolean;
  let service: OpenCodeService | null;
  let sessionID: string;
  let pid: number | null = null;
  try {
    const found = paneId ? await paneProcessRoots(paneId, label) : null;
    // a pid herdr did not report comes back as -1: unknown, not a process
    pid = found?.pid != null && found.pid > 0 ? found.pid : null;
    const roots = found ? typingRoots(found) : null;
    if (verification.cancelled || resolveAgent(pane, roots).agent !== "opencode") return null;
    const id = opencodeSessionId(pane);
    if (!id) return null;
    sessionID = id;
    service = await openCodeService(stateDir, signal);
    held = service !== null && Number(/^(\d+)\./u.exec(service.version)?.[1] ?? 0) >= 2 && await openCodeHasSession(service.config, sessionID, signal);
  } finally {
    inFlight.delete(verification);
    const own = paneId === undefined ? undefined : inFlightByPane.get(paneId);
    own?.delete(verification);
    if (own?.size === 0) inFlightByPane.delete(paneId!);
  }
  if (verification.cancelled || released) return null;
  // a newer verification already bound the pane: this older one neither releases it nor replaces its session, its
  // process or its stream
  const superseded = paneId !== undefined && (verifiedPanes.get(paneId)?.started ?? 0) > verification.started;
  if (!held) {
    if (paneId !== undefined && verifiedPanes.has(paneId) && !superseded) releaseOpenCodePane(paneId);
    return null;
  }
  if (paneId === undefined || superseded) return { service: service!, sessionID };
  const live = ensureStream(service!);
  verifiedPanes.delete(paneId);
  verifiedPanes.set(paneId, { sessionID, key: live.key, until: Date.now() + PANE_VERIFIED_MS, generation: ++verificationGeneration, pid, started: verification.started });
  for (const [track, { handed }] of paneTrackers) handOver(track, handed, paneId);
  scheduleRecheck();
  return { service: service!, sessionID };
}

const within = (path: string, directory: string): boolean => path === directory || path.startsWith(directory.endsWith("/") ? directory : `${directory}/`);

export async function openCodeCatalogRows(service: OpenCodeService, directory: string, signal?: AbortSignal): Promise<SlashCommand[] | null> {
  const live = stream?.key === JSON.stringify(service.config) ? stream : null;
  const key = `${JSON.stringify(service.config)}\0${directory}`;
  const cached = catalogs.get(key);
  if (cached) return cached;
  const catalog = await listOpenCodeCatalog(service.config, directory, signal);
  if (!catalog) return null;
  const builtins = new Set(AGENT_SOURCES["opencode"]?.builtins ?? []);
  const rows: SlashCommand[] = [
    ...catalog.commands.map((command): SlashCommand => ({
      name: command.name, description: command.description ?? "", source: builtins.has(command.name) ? "builtin" : "user",
    })),
    ...catalog.skills.map((skill): SlashCommand => ({
      name: skill.id, description: skill.description?.trim() ?? "", source: "skill", trigger: "@", id: skill.path,
      origin: skill.path.startsWith("/builtin/") ? "bundled" : within(skill.path, directory) ? "project" : "user",
    })),
  ];
  if (live?.connected) {
    if (catalogs.size >= CATALOG_MAX) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, rows);
  }
  return rows;
}

registerCatalogSource({
  agent: "opencode",
  owns: ["commands", "skills"],
  async rows(pane, cwd, signal, context) {
    const bound = await openCodePaneService(pane, signal, context?.openCodeStateDir);
    return bound ? await openCodeCatalogRows(bound.service, cwd, signal) : null;
  },
});

type Sent = (CommandSend & { store: string | null }) | undefined;
const UNKNOWN_FORMS = [{ match: "bare", interaction: "unknown" }] as const;

async function boundCatalog(pane: HerdrPane, cwd: string | null, budgetMs: number, stateDir?: string): Promise<{ bound: boolean; rows: SlashCommand[] | null }> {
  const deadline = Date.now() + budgetMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budgetMs); });
  const asked = (async () => {
    const version = (await openCodeService(stateDir, controller.signal))?.version ?? null;
    if (Date.now() >= deadline) { controller.abort(); return null; }
    const bound = version ? await openCodePaneService(pane, controller.signal, stateDir) : null;
    if (!bound) return null;
    return { bound: true, rows: cwd ? await openCodeCatalogRows(bound.service, cwd, controller.signal) : null };
  })().catch(() => null);
  try {
    const answer = await Promise.race([asked, expired]);
    return { bound: answer?.bound ?? false, rows: answer?.rows ?? null };
  } finally { clearTimeout(timer); }
}

export async function openCodeSkillsToType(pane: HerdrPane, sent: Sent, text: string, screen = "", stateDir?: string): Promise<{ sent: Sent; skills: string[] }> {
  const label = resolveAgent(pane).agent;
  if (label !== "opencode" || process.platform === "win32" || !/(?:^|\s)@\S/u.test(text)) return { sent, skills: [] };
  const roots = typingRoots(await paneProcessRoots(pane.pane_id, label));
  if (resolveAgent(pane, roots).agent !== "opencode") return { sent, skills: [] };
  const tokensOf = (record: Sent): string[] => record?.agent === "opencode" ? skillTokens(text, record.invocations.map((invocation) => invocation.name)) : [];
  const cached = cachedPaneCommands(pane);
  const cold = cached === undefined;
  let record = sent ?? (cached?.agent === "opencode" ? commandSendFrom(pane, "opencode", cached.commands, text, screen) : undefined);
  if (!cold && tokensOf(record).length === 0) return { sent: record, skills: [] };
  const cwd = pane.foreground_cwd ?? pane.cwd ?? null;
  const { bound, rows } = await boundCatalog(pane, cold ? cwd : null, CATALOG_SOURCE_BUDGET_MS, stateDir);
  if (cold) {
    const native = rows?.filter((row) => row.source !== "builtin").map((row): SlashCommand => ({ ...row, forms: row.forms ?? [...UNKNOWN_FORMS], visibility: row.visibility ?? "offered", provenance: { transport: "native", verified: true } }));
    // A synchronous scan cannot be interrupted by the lookup timer.
    record = commandSendFrom(pane, "opencode", [...builtinCommands("opencode"), ...(native ?? [])], text, screen);
    if (!native) return { sent: record, skills: [] };
  }
  const tokens = tokensOf(record);
  if (tokens.length === 0) return { sent: record, skills: [] };
  return bound ? { sent: record, skills: tokens } : { sent: skillsNotAttached(record!, tokens), skills: [] };
}

export function skillsNotAttached<T extends CommandSend>(sent: T, missed: readonly string[]): T {
  if (missed.length === 0) return sent;
  return { ...sent, form: { match: "bare", interaction: "terminal" }, unattached: [...missed], note: `OpenCode did not attach ${missed.map((id) => `@${id}`).join(", ")}; it was sent as plain text` };
}

export interface OpenCodeWatch {
  commit(sent: CommandSend, prompt: readonly PromptPiece[], attached: readonly string[]): void;
  cancel(): void;
}

export function startOpenCodeWatch(pane: HerdrPane, sent: CommandSend | undefined, stateDir?: string): OpenCodeWatch | null {
  if (!sent || sent.agent !== "opencode" || sent.form?.interaction === "terminal") return null;
  if (resolveAgent(pane).agent !== "opencode") return null;
  const sessionID = opencodeSessionId(pane);
  if (!sessionID) return null;
  const now = Date.now();
  for (let index = watches.length - 1; index >= 0; index--) if (watches[index]!.at + WATCH_MS <= now) watches.splice(index, 1);
  if (watches.length >= WATCH_MAX) watches.shift();
  const recent = verifiedPanes.get(pane.pane_id);
  const watch: Watch = { paneId: pane.pane_id, sessionID, at: sent.at, early: [], delivered: false, verified: recent?.sessionID === sessionID && recent.until > now };
  watches.push(watch);
  const remove = (): void => { const index = watches.indexOf(watch); if (index >= 0) watches.splice(index, 1); };
  const flush = (): void => {
    if (watch.sendId === undefined || !watch.verified) return;
    const early = watch.early;
    watch.early = [];
    for (const event of early) if (watches.includes(watch)) step(watch, event);
  };
  if (!watch.verified) {
    setTimeout(() => {
      if (!watches.includes(watch)) return;
      void openCodePaneService(pane, undefined, stateDir).then((bound) => {
        if (bound?.sessionID !== sessionID) { remove(); return; }
        watch.verified = true;
        flush();
      }, remove);
    }, 0);
  }
  return {
    commit(final, prompt, attached) {
      if (!watches.includes(watch) || watch.sendId !== undefined) return;
      if (final.form?.interaction === "terminal") { remove(); return; }
      watch.sendId = final.id;
      // only the command alone, as typed: with anything around it the TUI sends it as a prompt (or a server command)
      if (final.text === "/compact") watch.compact = {};
      watch.texts = openCodePromptTexts(prompt);
      watch.skills = new Set(attached);
      flush();
    },
    cancel: () => { if (watch.sendId === undefined) remove(); },
  };
}
