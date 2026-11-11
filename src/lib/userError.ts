import { ApiError } from "./api.ts";
import { t, type Translate } from "./i18n.ts";

export interface UserError {
  message: string;
  /** the server's or the browser's own words, kept visible and selectable; null when they add nothing */
  detail: string | null;
}

/** How a request failed, as far as the browser can tell. */
export type FailureKind = "signed-out" | "gone" | "changed" | "slow" | "unreachable" | "refused" | "unknown";

/**
 * A failure in the parts a chat or composer surface draws (DESIGN.md, Messages say only what the
 * person needs now): the action that failed and the cause make one line ("Couldn't attach · PC disk
 * is full"); with no known cause the line is the action alone and Try again stands beside it; the
 * advice and the server's or the browser's own words sit behind a Details toggle.
 */
export interface UserFailure {
  kind: FailureKind;
  /** a short phrase with no full stop ("PC disk is full"); null when the cause is not known */
  cause: string | null;
  /** what to do beyond trying again; null when trying again is all there is */
  advice: string | null;
  /** the server's or the browser's own words, kept selectable; null when they add nothing */
  detail: string | null;
}

/** What fetch rejects with when the request never got an answer: Chrome, Firefox and Safari words. */
const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed/i;

/** A cause the server's own words name outright, whatever the status: the words become the sentence. */
const NAMED_CAUSES: ReadonlyArray<[RegExp, () => string]> = [
  [/\bENOSPC\b|disk full|no space left/i, () => t("PC disk is full")],
  [/\bEACCES\b|\bEPERM\b|permission denied/i, () => t("No permission on the PC")],
];

/** A failure the server names by a code of its own, whatever the status: the sentence is the next step on the PC. */
const SENTENCE_BY_CODE: Readonly<Record<string, () => string>> = {
  // server/preferences.ts: its state folder refused the write, so no browser can save a shared setting
  preferences_unwritable: () => t("The server cannot save settings: check that its state folder is writable."),
};

/** The server's own words when herdr itself is away (server/herdr/client.ts names the socket it tried). */
const HERDR_AWAY = /cannot reach herdr/i;

function kindOf(cause: unknown): FailureKind {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return "signed-out";
    if (cause.status === 404) return "gone";
    if (cause.status === 409) return "changed";
    if (cause.status === 408 || cause.status === 504) return "slow";
    if (cause.status >= 500) return "refused";
    return "unknown";
  }
  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) return "slow";
  if (cause instanceof TypeError && NETWORK_FAILURE.test(cause.message)) return "unreachable";
  return "unknown";
}

function ownWords(cause: unknown): string {
  return cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause);
}

const SENTENCE: Record<FailureKind, () => string> = {
  "signed-out": () => t("This browser is not signed in to this PC any more. Pair it again in Settings → Devices and PCs."),
  gone: () => t("That item no longer exists on the PC. Refresh and try again."),
  changed: () => t("It changed on the PC while you were acting. Check it and try again."),
  slow: () => t("The PC took too long to answer. Try again."),
  unreachable: () => t("Can't reach the PC. Check your connection, then try again."),
  refused: () => t("The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC."),
  unknown: () => t("Something went wrong. Try again."),
};

const CAUSE: Record<FailureKind, (() => string) | null> = {
  "signed-out": () => t("Not signed in to this PC"),
  gone: () => t("It no longer exists on the PC"),
  changed: () => t("It changed on the PC"),
  slow: () => t("The PC took too long"),
  unreachable: () => t("Can't reach the PC"),
  refused: null,
  unknown: null,
};

const ADVICE: Record<FailureKind, (() => string) | null> = {
  "signed-out": () => t("Pair it again in Settings → Devices and PCs."),
  gone: () => t("Refresh and try again."),
  changed: () => t("Check it and try again."),
  slow: null,
  unreachable: () => t("Check your connection, then try again."),
  refused: () => t("Try again; if it keeps failing, restart Ovis on the PC."),
  unknown: null,
};

/** A plain sentence for a failure, with what the server or the browser said kept beside it. */
export function userErrorMessage(cause: unknown): UserError {
  const coded = cause instanceof ApiError && cause.code !== null && Object.hasOwn(SENTENCE_BY_CODE, cause.code) ? SENTENCE_BY_CODE[cause.code] : undefined;
  const message = coded?.() ?? SENTENCE[kindOf(cause)]();
  const original = ownWords(cause);
  return { message, detail: original.trim() === "" || original === message ? null : original };
}

/**
 * Whether the server's words say herdr itself is away on its PC: nothing in this browser helps, so
 * the sidebar's state line and the header's pill add the step to take there.
 */
export function saysHerdrAway(words: string): boolean {
  return HERDR_AWAY.test(words);
}

/**
 * The server's fixed sentences for another PC's answer it would not hold (server/remote-json.ts).
 * They reach a PC's error and its setup job's error as they are, so the sidebar and the PC dialog
 * show them in the user's language; any other words pass through unchanged.
 */
export function machineErrorText(words: string, translateIn: Translate): string {
  const t = translateIn;
  const known: ReadonlyArray<[string, string]> = [
    ["The other PC's answer was larger than this app accepts", t("The other PC's answer was larger than this app accepts")],
    ["The other PC's answer could not be read", t("The other PC's answer could not be read")],
    ["Start Ovis on that PC, or start a new herdr here", t("Start Ovis on that PC, or start a new herdr here")],
    ["Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.", t("Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.")],
    ["The Ovis chosen on this PC serves herdr-core from a socket that is not this SSH account's own, so it was not used. Choose again, or start a new herdr here.", t("The Ovis chosen on this PC serves herdr-core from a socket that is not this SSH account's own, so it was not used. Choose again, or start a new herdr here.")],
    ["Choosing this PC's Ovis server over SSH requires Linux or macOS", t("Choosing this PC's Ovis server over SSH requires Linux or macOS")],
    ["Choose this PC's Ovis server or a running herdr session.", t("Choose this PC's Ovis server or a running herdr session.")],
    ["A herdr session is already running on this PC. Choose it, or start a new one.", t("A herdr session is already running on this PC. Choose it, or start a new one.")],
    ["The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again.", t("The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again.")],
  ];
  return known.reduce((text, [english, local]) => text.replaceAll(english, local), words);
}

/** What ssh itself said when a PC could not be reached: the kind of refusal, and the host and port it named. */
export interface SshFailure {
  reason: "refused" | "unreachable" | "timeout" | "unknown-host" | "auth";
  host: string | null;
  port: string | null;
}

const SSH_REASONS: ReadonlyArray<[RegExp, SshFailure["reason"]]> = [
  [/connection refused/i, "refused"],
  [/could not resolve hostname|name or service not known|nodename nor servname/i, "unknown-host"],
  [/timed out|timeout/i, "timeout"],
  [/no route to host|network is unreachable|host is down/i, "unreachable"],
  [/permission denied|authentication failed|too many authentication failures/i, "auth"],
];

/**
 * The sidebar's one-line reading of an SSH failure (G-031): ssh's own words name the host and port it tried
 * (`ssh: connect to host old-desktop port 22: Connection refused`), and a few reasons are common enough to
 * say in plain words. Null for any other failure, which is shown as written.
 */
export function sshFailure(words: string): SshFailure | null {
  const reason = SSH_REASONS.find(([pattern]) => pattern.test(words))?.[1];
  if (reason === undefined) return null;
  const target = /connect to host (\S+) port (\d+)/i.exec(words) ?? /hostname (\S+?):?\s/i.exec(words);
  return { reason, host: target?.[1] ?? null, port: target?.[2] ?? null };
}

/** The failure's parts: the cause when the status or the server's words name one, the advice, the words. */
export function userFailure(cause: unknown): UserFailure {
  const kind = kindOf(cause);
  const original = ownWords(cause).trim();
  const named = NAMED_CAUSES.find(([pattern]) => pattern.test(original))?.[1];
  return { kind, cause: named?.() ?? CAUSE[kind]?.() ?? null, advice: ADVICE[kind]?.() ?? null, detail: original === "" ? null : original };
}

/** Whether Try again is the control beside the line: no cause is known, or the PC was only slow. */
export function offersRetry(failure: UserFailure): boolean {
  return failure.cause === null || failure.kind === "slow";
}
