import type { SetupErrorCode, SetupStepCode } from "../../shared/machines.ts";
import { ApiError } from "./api.ts";
import { t, type Translate } from "./i18n.ts";

export interface UserError {
  message: string;
  detail: string | null;
}

export type FailureKind = "signed-out" | "gone" | "changed" | "slow" | "unreachable" | "refused" | "unknown";

export interface UserFailure {
  kind: FailureKind;
  cause: string | null;
  advice: string | null;
  detail: string | null;
}

/** What fetch rejects with when the request never got an answer: Chrome, Firefox and Safari words. */
const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed/i;

const NAMED_CAUSES: ReadonlyArray<[RegExp, () => string]> = [
  [/\bENOSPC\b|disk full|no space left/i, () => t("PC disk is full")],
  [/\bEACCES\b|\bEPERM\b|permission denied/i, () => t("No permission on the PC")],
];

const SENTENCE_BY_CODE: Readonly<Record<string, () => string>> = {
  preferences_unwritable: () => t("The server cannot save settings: check that its state folder is writable."),
};

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

export function userErrorMessage(cause: unknown): UserError {
  const coded = cause instanceof ApiError && cause.code !== null && Object.hasOwn(SENTENCE_BY_CODE, cause.code) ? SENTENCE_BY_CODE[cause.code] : undefined;
  const message = coded?.() ?? SENTENCE[kindOf(cause)]();
  const original = ownWords(cause);
  return { message, detail: original.trim() === "" || original === message ? null : original };
}

export function saysHerdrAway(words: string): boolean {
  return HERDR_AWAY.test(words);
}

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
    ["That PC runs only a bridge this app started, not Ovis of its own. Install Ovis on it, then add it to your account.", t("That PC runs only a bridge this app started, not Ovis of its own. Install Ovis on it, then add it to your account.")],
    ["Ovis is not running on that PC. Install it there, then add it to your account.", t("Ovis is not running on that PC. Install it there, then add it to your account.")],
    ["Adding a Windows PC to your account over SSH is not supported yet. Add it with the number on its Ovis page.", t("Adding a Windows PC to your account over SSH is not supported yet. Add it with the number on its Ovis page.")],
    ["Adding a PC to your account over SSH from Windows needs OpenSSH 9.4 or newer on this PC. Update Git for Windows (or OpenSSH), then try again.", t("Adding a PC to your account over SSH from Windows needs OpenSSH 9.4 or newer on this PC. Update Git for Windows (or OpenSSH), then try again.")],
    ["That PC's Ovis is too old to be added over SSH. Update it there, then try again.", t("That PC's Ovis is too old to be added over SSH. Update it there, then try again.")],
  ];
  return known.reduce((text, [english, local]) => text.replaceAll(english, local), words);
}

/** a prerelease (-beta, -preview): offered only as a preview, never as a plain update */
export function previewVersion(version: string | null | undefined): boolean {
  return version?.includes("-") === true;
}

/**
 * A failed setup's words in the app's language: from its code where the server gave one, else its English as
 * machineErrorText reads it. A prerelease target is named a preview, with a line that it
 * is a test build.
 */
export function setupErrorLines(job: { error: string | null; error_code?: SetupErrorCode | null }, t: Translate): string[] {
  const coded = job.error_code;
  if (!coded) return job.error ? [machineErrorText(job.error, t)] : [];
  const older = coded.version ? t("This PC runs its own Ovis {version}, older than this app.", { version: `v${coded.version}` }) : t("This PC runs its own Ovis, older than this app.");
  const preview = previewVersion(coded.target);
  const update = coded.target === null ? t("Update it to reconnect.")
    : preview ? t("Update it to the preview version {target} to reconnect.", { target: `v${coded.target}` })
    : t("Update it to {target} to reconnect.", { target: `v${coded.target}` });
  return [`${older} ${update}`, ...(preview ? [t("A preview version is a test build, not a stable release.")] : [])];
}

/**
 * A setup step's words in the app's language: from its code where the server gave one, else as it came (an older
 * server's English, a PC's own notice). An own Ovis's prerelease target is named a preview, as setupErrorLines does.
 */
export function setupStepText(job: { step: string; step_code?: SetupStepCode | null }, t: Translate): string {
  const step = job.step_code;
  if (!step) return job.step;
  const ownStage = (stage: string): string => {
    switch (stage) {
      case "download": return t("downloading");
      case "dependencies": return t("installing dependencies");
      case "typecheck": return t("type-checking");
      case "build": case "building": return t("building");
      case "restart": case "restarting": return t("restarting");
      default: return stage;
    }
  };
  switch (step.code) {
    case "connecting": return t("Connecting with SSH keys and ssh-agent…");
    case "fingerprint": return t("Verify the server fingerprint");
    case "authentication": return t("SSH authentication required");
    case "checking": return t("Checking the remote environment…");
    case "review": return t("Review the changes on this PC");
    case "installing": return t("Installing on this PC…");
    case "install_bundle": return t("Installing verified {platform} bundle…", { platform: step.platform });
    case "install_herdr": return t("Installing herdr with its own installer…");
    case "register_key": return t("Registering the app SSH key…");
    case "restart_bridge": return t("Restarting the verified remote bridge…");
    case "start_bridge": return t("Starting the remote bridge…");
    case "own_update_ask": return step.target === null ? t("Asking this PC's own Ovis to update itself…")
      : previewVersion(step.target) ? t("Asking this PC's own Ovis to update itself to the preview version {target}…", { target: `v${step.target}` })
      : t("Asking this PC's own Ovis to update itself to {target}…", { target: `v${step.target}` });
    case "own_update_running": return step.target === null ? t("This PC's own Ovis is updating itself: {stage}…", { stage: ownStage(step.stage) })
      : previewVersion(step.target) ? t("This PC's own Ovis is updating itself to the preview version {target}: {stage}…", { target: `v${step.target}`, stage: ownStage(step.stage) })
      : t("This PC's own Ovis is updating itself to {target}: {stage}…", { target: `v${step.target}`, stage: ownStage(step.stage) });
    case "own_update_connect": return t("Connecting to this PC's updated Ovis…");
    case "headless": return t("Starting without Windows sign-in…");
    case "connected": return t("Connected");
    case "failed": return t("Connection failed");
    case "timed_out": return t("Connection timed out");
    case "cancelled": return t("Cancelled");
  }
}

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

export function userFailure(cause: unknown): UserFailure {
  const kind = kindOf(cause);
  const original = ownWords(cause).trim();
  const named = NAMED_CAUSES.find(([pattern]) => pattern.test(original))?.[1];
  return { kind, cause: named?.() ?? CAUSE[kind]?.() ?? null, advice: ADVICE[kind]?.() ?? null, detail: original === "" ? null : original };
}

export function offersRetry(failure: UserFailure): boolean {
  return failure.cause === null || failure.kind === "slow";
}

const FAILURE_REASON_MAX = 160;
const LINE_BREAK_RE = /\r\n|[\r\n\u0085\u2028\u2029]/;

function singleLineReason(detail: string): string | null {
  const first = detail.split(LINE_BREAK_RE).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  if (first === "") return null;
  if (first.length <= FAILURE_REASON_MAX) return first;
  let cut = first.slice(0, FAILURE_REASON_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** A failed upload: as `userFailure`, but an answer with no body words and no known status cause names its HTTP status. */
export function uploadFailure(cause: unknown): UserFailure {
  if (cause instanceof ApiError && cause.fromStatusText) {
    const kind = kindOf(cause);
    const statusCause = CAUSE[kind]?.() ?? null;
    return {
      kind,
      cause: statusCause,
      advice: ADVICE[kind]?.() ?? null,
      detail: statusCause === null ? `HTTP ${cause.status}` : null,
    };
  }
  const failure = userFailure(cause);
  return failure.cause === null && failure.detail === null && cause instanceof ApiError
    ? { ...failure, detail: `HTTP ${cause.status}` }
    : failure;
}

/** What a one-line failure says after its subject: the plain cause, or else a compact single-line summary of the error's words. */
export function failureReason(failure: UserFailure): string | null {
  return failure.cause ?? (failure.detail === null ? null : singleLineReason(failure.detail));
}
