/**
 * What an OpenCode v2 pane's own service says, read only from a service that already runs and that
 * /api/info proves is the one service.json names (never started or ensured here): the command and
 * skill rows for the pane's directory, and the skill-activation and turn-completion events of the
 * pane's exact session, which settle a Chat send's outcome as native evidence.
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
 * an execution, and `session.execution.succeeded` ends that execution. A watch exists before the
 * send's first key (startOpenCodeWatch, synchronous): events wait in `early` until the send is
 * committed and its pane's service and session are verified, then are read in order, so the send's
 * own message cannot pass unseen and nothing about watching ever waits on the service.
 */
interface Watch {
  paneId: string; sessionID: string; at: number;
  /** set by commit: the send, and the exact texts and skill set its own message can carry */
  sendId?: string; texts?: ReadonlySet<string>; skills?: ReadonlySet<string>;
  early: OpenCodeEvent[]; inboxID?: string; delivered: boolean;
  /** the pane's service holds this session (checked in the background, or recently) */
  verified: boolean;
}
const watches: Watch[] = [];
const WATCH_MS = 10 * 60_000;
const WATCH_MAX = 64;
const EARLY_MAX = 256;
/** how long a pane's verified service and session are trusted without asking again (as openCodeService's) */
const PANE_VERIFIED_MS = 5_000;
/**
 * The panes that keep the shared event stream open: each verified to run OpenCode v2 on the stream's
 * service with its session there. A pane's end, its agent changing, or a verification that now fails
 * releases it; the stream closes when no verified pane uses its service.
 */
const verifiedPanes = new Map<string, { sessionID: string; key: string; until: number; generation: number }>();
let verificationGeneration = 0;
/** A collector snapshot can release only ownership verified before its read began. */
export function openCodeVerificationCheckpoint(): number { return verificationGeneration; }
/**
 * The verifications still in flight: all of them (a reset cancels every one), and per pane (its
 * release cancels that pane's). A cancelled verification opens no stream and caches nothing. Each
 * set holds only verifications in flight, and a pane's entry goes when its last one finishes, so
 * nothing is evicted and no cancellation can be undone.
 */
/** `started`: the verification counter when it began, so a snapshot read before it cannot cancel it */
type Verification = { cancelled: boolean; started: number };
const inFlight = new Set<Verification>();
const inFlightByPane = new Map<string, Set<Verification>>();
/** the status collectors that end a pane: a verified pane is tracked so its close reaches releaseOpenCodePane */
const paneTrackers = new Map<(paneId: string) => void, Set<string>>();
/** each tracker gets a pane once while it stays verified: tracking asks herdr for a snapshot */
function handOver(track: (paneId: string) => void, handed: Set<string>, paneId: string): void {
  if (handed.has(paneId)) return;
  handed.add(paneId);
  track(paneId);
}

/**
 * A status hub's collector tracks verified OpenCode panes (server/core/status.ts): it gets every pane
 * verified now, and each one verified later, so a collector that replaces another misses no pane.
 * Returns its unregistration.
 */
export function trackVerifiedOpenCodePanes(track: (paneId: string) => void): () => void {
  const handed = new Set<string>();
  paneTrackers.set(track, handed);
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
  if (event.type === "session.inbox.enqueued" && watch.inboxID === undefined) {
    // this send's own message: one of its exact texts, with exactly the skills the autocomplete attached
    const message = enqueuedMessage(event.data);
    if (message && watch.texts!.has(message.text) && sameSet(message.skills, watch.skills!)) watch.inboxID = message.inboxID;
  } else if (event.type === "session.inbox.delivered" && watch.inboxID !== undefined && event.data.inboxID === watch.inboxID) watch.delivered = true;
  else if (event.type === "session.execution.succeeded" && watch.delivered) {
    watches.splice(watches.indexOf(watch), 1);
    noteCommandEvidence(watch.paneId, watch.sendId!, { kind: "native", at: event.created! });
  } else if ((event.type === "session.execution.failed" || event.type === "session.execution.interrupted") && watch.delivered) {
    // the execution that took this message did not succeed: no evidence, and nothing later is about it
    watches.splice(watches.indexOf(watch), 1);
  }
}

function onEvent(event: OpenCodeEvent): void {
  // a user or project command or skill changed somewhere: every cached list may be stale
  if (event.type === "command.updated" || event.type === "skill.updated") { catalogs.clear(); return; }
  const sessionID = event.data.sessionID;
  if (typeof sessionID !== "string" || event.created === undefined) return;
  for (const watch of [...watches]) {
    if (watch.sessionID !== sessionID || event.created <= watch.at || !watches.includes(watch)) continue;
    if (watch.sendId === undefined || !watch.verified) { if (watch.early.length < EARLY_MAX) watch.early.push(event); }
    else step(watch, event);
  }
}

/** One stream per verified service; a different service (a restart, another pid) replaces it. */
function ensureStream(service: OpenCodeService): Stream {
  const key = JSON.stringify(service.config);
  if (stream?.key === key) return stream;
  // another service (a restart, another pid): its old stream and the panes verified on it go
  stream?.close();
  stream = null;
  catalogs.clear();
  for (const [paneId, entry] of verifiedPanes) if (entry.key !== key) verifiedPanes.delete(paneId);
  const next: Stream = { key, connected: false, close: () => {} };
  const subscription = subscribeOpenCodeEvents(service.config, {
    // whatever happened while it was down is gone: cached lists are read again
    onOpen: () => { catalogs.clear(); next.connected = true; },
    onClose: () => { catalogs.clear(); next.connected = false; },
    onEvent,
  });
  next.close = () => subscription.close();
  stream = next;
  return next;
}

/**
 * The servers running in this process (createServer holds, its stop releases): the stream, the verified
 * panes and the watches are shared by all of them, so a server that stops resets them only when no other
 * still runs. After the last release a verification still on its way opens no stream (`released`).
 */
let holders = 0;
let released = false;

/** Held by a running server; the release (idempotent) of the last holder resets everything (closeOpenCodeNative). */
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

/** A global reset: closes the stream, forgets every pane and watch, and cancels verifications in flight. What follows starts over. */
export function closeOpenCodeNative(): void {
  released = false;
  for (const verification of inFlight) verification.cancelled = true;
  inFlight.clear();
  inFlightByPane.clear();
  for (const handed of paneTrackers.values()) handed.clear();
  stream?.close();
  stream = null;
  catalogs.clear();
  watches.length = 0;
  verifiedPanes.clear();
}

/**
 * A pane ended, or is no longer OpenCode v2 (server/core/status.ts calls this from the same pane-end
 * and agent-change paths that forget its other state): its watches and its hold on the stream go, a
 * verification of it still in flight is cancelled, and the stream closes once no verified pane uses it.
 * A snapshot supplies its starting checkpoint: verification since then is newer evidence and stays.
 */
export function releaseOpenCodePane(paneId: string, checkpoint = Infinity): void {
  if ((verifiedPanes.get(paneId)?.generation ?? 0) > checkpoint) return;
  // a verification begun since the snapshot's read is newer evidence too: it settles the pane itself
  for (const verification of inFlightByPane.get(paneId) ?? []) if (verification.started > checkpoint) return;
  for (const verification of inFlightByPane.get(paneId) ?? []) { verification.cancelled = true; inFlight.delete(verification); }
  inFlightByPane.delete(paneId);
  for (const handed of paneTrackers.values()) handed.delete(paneId);
  verifiedPanes.delete(paneId);
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

/** The verified service a pane's exact session lives in, or null (scan rows and screen paths stay). */
export async function openCodePaneService(pane: Pick<HerdrPane, "agent" | "agent_session"> & { pane_id?: string }, signal?: AbortSignal, stateDir?: string): Promise<{ service: OpenCodeService; sessionID: string } | null> {
  const label = resolveAgent(pane).agent;
  if (label !== "opencode") return null;
  const paneId = pane.pane_id;
  // registered before the first wait (the process roots too), so a release or reset meanwhile cancels it
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
  try {
    const roots = paneId ? typingRoots(await paneProcessRoots(paneId, label)) : null;
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
  // a reset or the pane's release while this was asked, or the last server stopped: nothing it found is used or kept
  if (verification.cancelled || released) return null;
  if (!held) {
    // no longer an OpenCode v2 pane on a verified service: it holds the stream no more
    if (paneId !== undefined && verifiedPanes.has(paneId)) releaseOpenCodePane(paneId);
    return null;
  }
  if (paneId === undefined) return { service: service!, sessionID };
  // a verified OpenCode v2 pane keeps its service's event stream open, so a later send's events are not missed
  const live = ensureStream(service!);
  verifiedPanes.delete(paneId);
  verifiedPanes.set(paneId, { sessionID, key: live.key, until: Date.now() + PANE_VERIFIED_MS, generation: ++verificationGeneration });
  // a pane closed without an exit frame ends only if its collector tracks it
  for (const [track, handed] of paneTrackers) handOver(track, handed, paneId);
  return { service: service!, sessionID };
}

const within = (path: string, directory: string): boolean => path === directory || path.startsWith(directory.endsWith("/") ? directory : `${directory}/`);

/** The service's rows as catalog rows: its builtin commands stay the static rows' business. */
export async function openCodeCatalogRows(service: OpenCodeService, directory: string, signal?: AbortSignal): Promise<SlashCommand[] | null> {
  // the stream belongs to the verified panes; a read only uses it, to know when cached lists change
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
  // cached only while the stream is up to say when the lists change
  if (live?.connected) {
    if (catalogs.size >= CATALOG_MAX) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, rows);
  }
  return rows;
}

registerCatalogSource({
  agent: "opencode",
  // its own command and skill lists: an empty list is an answer too
  owns: ["commands", "skills"],
  async rows(pane, cwd, signal, context) {
    const bound = await openCodePaneService(pane, signal, context?.openCodeStateDir);
    return bound ? await openCodeCatalogRows(bound.service, cwd, signal) : null;
  },
});

type Sent = (CommandSend & { store: string | null }) | undefined;
const UNKNOWN_FORMS = [{ match: "bare", interaction: "unknown" }] as const;

/** The pane's verified service and (for `cwd`) its lists, under one budget for all of it. */
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

/**
 * The `@skill` tokens to type through OpenCode v2's autocomplete, and the send record to keep. Only an
 * OpenCode pane's text with an `@` token waits here (delivery has to, to attach a skill), and only up to
 * the catalog budget. With no catalog remembered for the pane's current identity (a bridge restarted
 * under an open tab, a new OpenCode session), the record is made from the verified service's own lists,
 * never from a synchronous filesystem scan on the delivery path. A skill that cannot be attached goes as
 * plain text and its record is terminal-required with the note why.
 */
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
    // A synchronous scan cannot be interrupted by the lookup timer. Without a native catalog,
    // no mention is known to be a skill; files and other @words remain ordinary plain text.
    record = commandSendFrom(pane, "opencode", [...builtinCommands("opencode"), ...(native ?? [])], text, screen);
    if (!native) return { sent: record, skills: [] };
  }
  const tokens = tokensOf(record);
  if (tokens.length === 0) return { sent: record, skills: [] };
  return bound ? { sent: record, skills: tokens } : { sent: skillsNotAttached(record!, tokens), skills: [] };
}

/** A send whose skill stayed plain text needs the terminal to attach it; the note says which. */
export function skillsNotAttached<T extends CommandSend>(sent: T, missed: readonly string[]): T {
  if (missed.length === 0) return sent;
  return { ...sent, form: { match: "bare", interaction: "terminal" }, unattached: [...missed], note: `OpenCode did not attach ${missed.map((id) => `@${id}`).join(", ")}; it was sent as plain text` };
}

export interface OpenCodeWatch {
  /** after Enter and noteSubmitted: what this send put into the prompt and which skills OpenCode attached */
  commit(sent: CommandSend, prompt: readonly PromptPiece[], attached: readonly string[]): void;
  /** nothing was sent, or the send needs the terminal: stop following it */
  cancel(): void;
}

/**
 * Starts following a Chat send to an OpenCode v2 pane before its first key (see Watch). Synchronous,
 * in memory only: delivery never waits for it. The pane's service and session are verified in the
 * background (or were, moments ago); a pane that fails that, or a stream that never opens, leaves the
 * outcome to the other evidence (accepted, then unknown). Null for anything that is not followed.
 */
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
  // even service.json's read happens after this returns: registration is in-memory work only
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
      watch.texts = openCodePromptTexts(prompt);
      watch.skills = new Set(attached);
      flush();
    },
    cancel: () => { if (watch.sendId === undefined) remove(); },
  };
}
