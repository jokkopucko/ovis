/**
 * `link`: a PC with no screen of its own joins the relay from its terminal (docs/relay.md, "A PC
 * with no screen"). Both ways are the ones its own Settings page offers, through the same routes:
 *
 * - `link` (also `add` and `login`, scripts/plugin-runtime.ts COMMAND_ALIASES): sign in to the account with a device code (as a PC's own page does,
 *   src/lib/account/deviceSignIn.ts): the Ovis link page's where the service has it, else, or with
 *   `--github` / `--google`, the provider's own device flow. Then list this PC in the account (src/lib/account/addThisPc.ts),
 *   then show one QR code: a device signed in to that account that scans it puts this PC in the account, with nothing
 *   to type and nothing to approve here (docs/account.md, "Who may admit a device": a code admits whoever holds it).
 *   So the code is shown only on a terminal (or with `--print`), on a screen of its own that goes when it ends, for
 *   30 minutes at most (under the fleet preview, server/preview.ts: only on a terminal, `--print` too, and only once
 *   Enter was pressed there under the name of the account that signed in), and the command says which account this PC
 *   joined and by which of its devices. Any other device the code let in is asked about, and removed unless the person
 *   types keep; with this PC in another account than the one that signed in, every device that came since the code was
 *   shown is removed.
 * - `link --approve`: the same sign-in, then approve here, after comparing six digits, the device of the account that
 *   adds it.
 * - `link --code`: the code to type and the relay QR code that Connect a device shows, renewed
 *   as they run out, until Ctrl+C.
 *
 * It talks only to a server on this machine (a loopback address): approving a device is an act of
 * the PC itself (docs/account.md, "Who may admit a device"), and the sign-in lives in this process.
 */
import { dlopen, FFIType } from "bun:ffi";
import { hostname } from "node:os";

import qrcode from "qrcode-generator";

import { isLoopbackHost } from "../server/access.ts";
import { fleetPreview } from "../server/preview.ts";
import { accountOsOfPlatform } from "../shared/account-asker.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../shared/web-policy.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { startDeviceSignIn, startLinkPageSignIn } from "../src/lib/account/deviceSignIn.ts";
import { NEW_PC_MS } from "../src/lib/account/myPcs.ts";
import { AccountService, AccountServiceError, DEVICE_PROVIDERS, offeredProviders, type DeviceProvider } from "../src/lib/account/service.ts";
import { memoryAccountStore, memoryLock, type AccountProvider } from "../src/lib/account/store.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LinkOptions {
  readonly origin: string;
  /** its token, when it has one */
  readonly headers: Record<string, string>;
  readonly accountService: string | null;
  readonly app?: string;
  readonly preview?: boolean;
  readonly cliName?: string;
  readonly out: (text: string) => void;
  readonly lines: AsyncIterator<string>;
  /**
   * `lines` is a terminal a person types at. Anything else (a pipe, a file, a closed stdin) answers nothing, whenever
   * its lines come: nobody compared the digits a line of `yes | ovis add` arrives under. Unset counts as not one.
   */
  readonly terminal?: boolean;
  readonly discard?: () => boolean;
  /**
   * `out` is a terminal: the only place the QR code that adds this PC is drawn without `--print`, since whoever reads
   * it can pair with this PC. Unset counts as not one.
   */
  readonly isTty?: boolean;
  readonly size?: () => { readonly rows: number; readonly columns: number } | null;
  readonly signal: AbortSignal;
  readonly fetch?: Fetch;
  readonly serviceFetch?: Fetch;
  readonly now?: () => number;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const POLL_MS = 2_000;
/** The approve-here window lasts ten minutes; it is opened again a minute before it ends (AccountSection RELIST_MS). */
const RELIST_MS = 9 * 60_000;
/**
 * The window lives in the server's memory, so a server that restarted has none: it is asked for again this
 * often, which only moves its end (pairing-approvals.ts openWindow) and writes nothing to the account.
 */
const REOPEN_MS = 30_000;
/** How long one run keeps the approve-here window open before it stops by itself. */
const WAITING_MS = 30 * 60_000;
/** How long the server keeps a window it was asked for (pairing-approvals.ts PAIRING_WINDOW_MS). */
const WINDOW_MS = 10 * 60_000;
/**
 * The end of the time in which a window may still be asked for: every look in it asks, and the first lists the PC
 * anew. A fixed span, not a guess from how long the last look took: the last window is then the one of the last look
 * that came in time, however slow the look after it turns out to be. One look that alone takes longer than this
 * (the PC's server or the account service stalling for over half a minute right there) can step over the span: the
 * last window is then the one asked for before it, and ends that much before the run does, never after it.
 */
const LAST_MS = 30_000;
/**
 * How long a request's question, with its digits, is on the screen before a line may answer it. A line that comes
 * sooner was not typed after comparing them: it is a key pressed twice, or a second line typed right after the answer
 * to the request before. It is dropped, and the question is asked again. A line begun at a request that then went
 * away can come at any time after the next question shows, so that one is dropped by itself (`held`), and no answer
 * approves without the request's own digits (`answerOf`). The question about a device the QR code let in (`addByQr`)
 * is kept by the same two: a line that comes sooner is dropped, and so is the first after a question that changed.
 */
const DWELL_MS = 1_500;
/** How many codes one run shows, one after another: each lasts ten minutes, so about the run's 30 in all. */
const MAX_CODES = 3;
/**
 * How long a device that paired gets to put this PC in its account before it is asked about: one that is signed in
 * links itself and lists the PC within seconds (src/lib/relay/accountController.ts).
 */
const ALONE_MS = 15_000;
/**
 * How long removing the devices nobody vouched for may take as a run ends, after its code was taken back (five seconds
 * at most, endCode): a run that was stopped has ten in all before its process ends (plugin.ts).
 */
const SWEEP_MS = 4_000;
/**
 * How often the devices are read again while those nobody vouched for are removed: a member of another account
 * brings that account's other devices in meanwhile.
 */
const CLEAR_ROUNDS = 4;
/**
 * How often one such read is tried when this PC does not answer it, and how long between two tries, before the
 * devices count as unreadable: what may still be paired is then not known, and is said so.
 */
const CLEAR_READS = 3;
const CLEAR_RETRY_MS = 500;
/** The terminal's other screen: what is drawn there is gone, scrollback and all, once it is left. */
const SCREEN_ON = "\x1b[?1049h";
const SCREEN_OFF = "\x1b[?1049l";
const SCREEN_CLEAR = "\x1b[2J\x1b[H";

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    // fixed wait: the time until the code runs out, or the poll interval while a device is awaited
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function qr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createASCII(1, 1);
}

class LocalError extends Error {
  /** `reason`: what is shown to a person, without the route `message` starts with (localApi) */
  constructor(message: string, readonly status = 0, readonly code = "", readonly reason = message) { super(message); }
}

class AwayError extends Error {}

/**
 * What `add` reads of a code it asked for for the account that signed in (`x-ovis-expect-account`; docs/account.md,
 * "A code made for an account"): the account the PC made it for, and the code's id. An Ovis from before that answers
 * neither field.
 */
interface ForAccount { readonly expect_account?: string; readonly pairing?: { readonly id: string } }

/**
 * The refusals of a code that start none and leave the code pending as it was: the relay is off or not online, this PC
 * is in an account by now, or it did not take the account's id.
 */
const NO_CODE_STARTED: ReadonlySet<string> = new Set(["relay_off", "relay_offline", "in_account", "invalid_account"]);

/** Why a code made for the account that signed in ended before it ran out (POST /api/relay/offer/keep, `ended.why`), as `add` says it. */
const CODE_ENDED: Readonly<Record<string, string>> = {
  replaced: "another pairing code was made on this PC, which replaced it.",
  cancelled: "it was taken back on this PC.",
  revoked: "a device that held it was revoked on this PC.",
  overused: "five devices paired with it, and none of them joined your account.",
  guessed: "a wrong code was typed for it five times.",
};

/** What `add` says of a code from an Ovis that makes its codes for no account: on its QR code's screen, or once with --print. */
const OLDER_PC = "The Ovis on this PC is older than this command. Update it in Settings → Updates on this PC before you pair a new device.";

/**
 * What a run takes back of the code it made (endCode): the code's id (`pairing.id`) and the six digits its QR code
 * carries, each that its answers gave. A code that neither names is not the run's to take back.
 */
interface Mine { readonly id?: string; readonly code?: string }

const mineOf = (code: string | undefined, id: string | undefined): Mine | null =>
  code === undefined && id === undefined ? null : { ...code !== undefined ? { code } : {}, ...id !== undefined ? { id } : {} };

/** What a machine profile answers a code with: it takes devices through its account (`machine_profile`), not by a code. */
const onMachine = (error: unknown): boolean => error instanceof LocalError && error.code === "machine_profile";

function localApi(options: LinkOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const control = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: options.origin };
  return async <T>(method: "GET" | "POST" | "DELETE", path: string, extra: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${options.origin}${path}`, {
        method, headers: { ...(method === "GET" ? {} : control), ...options.headers, ...extra.headers },
        ...(method === "GET" ? {} : { body: JSON.stringify(extra.body ?? {}) }),
        signal: extra.signal ?? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new AwayError(`${path}: the Ovis on this PC did not answer (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!response.ok) {
      let message = `${response.status}`;
      let code = "";
      try {
        const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
        if (typeof body.error?.code === "string") code = body.error.code;
      } catch {}
      throw new LocalError(`${path}: ${message}`, response.status, code, message);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };
}

type Api = ReturnType<typeof localApi>;

const ONLINE_MS = 30_000;

/**
 * The relay on and online, as both ways need it: turned on when it is off, which is what linking
 * asks for. Pairing waits for Online, as Settings does: a code asked for while it connects is refused.
 */
async function relayOnline(options: LinkOptions, api: Api): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  let status = await relayOn(options, api);
  const deadline = now() + ONLINE_MS;
  while (status.phase !== "online") {
    if (now() >= deadline) throw new LocalError("The Ovis relay did not come online in 30 seconds. Check this PC's internet connection and try again.");
    await wait(500, options.signal);
    status = await api<{ phase: string; blocked: string | null }>("GET", "/api/relay");
  }
}

/** The relay turned on (not yet online): an Ovis relay that asks for a pass comes online only once this PC names its account. */
async function relayOn(options: LinkOptions, api: Api): Promise<{ phase: string; blocked: string | null }> {
  let status = await api<{ phase: string; blocked: string | null }>("GET", "/api/relay");
  if (status.blocked) throw new LocalError(`The Ovis relay cannot run here (${status.blocked}).`);
  if (status.phase === "off") {
    options.out("Turning on the Ovis relay (Settings → Devices and PCs → Ovis relay turns it off again).\n");
    status = await api<{ phase: string; blocked: string | null }>("POST", "/api/relay/start");
    if (status.blocked) throw new LocalError(`The Ovis relay cannot run here (${status.blocked}).`);
  }
  return status;
}

/**
 * A label a requesting device chose, as plain text: its terminal controls (C0, DEL, C1) dropped, so it
 * cannot clear the screen or hide the digits it is shown with.
 */
export const plainLabel = (label: string): string => label.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const SIX_DIGITS = /^[0-9]{6}$/;

export interface AskingDevice { readonly label: string; readonly digits: string; readonly intent?: string }

/**
 * The question a terminal asks about a device that wants in: its six digits, to compare with that device's screen,
 * and what to type. The answer that approves carries the request's own digits (`answerOf`), so it names the request
 * it is for. `whole`: its last three digits are another request's too, so they name neither, and all six are asked for.
 */
export function approvalPrompt(device: AskingDevice, whole = false): string {
  const what = device.intent === "account" ? "join your account" : "pair with this PC";
  // digits that are not six digits approve nothing (`answerOf`): the question does not ask for them
  if (!SIX_DIGITS.test(device.digits)) return `${plainLabel(device.label)} wants to ${what}, but its request came without six digits to compare, so it cannot be approved here. Press Enter to decline: `;
  const shows = `${plainLabel(device.label)} wants to ${what}. Approve it only if its screen shows ${device.digits.slice(0, 3)} ${device.digits.slice(3)}.`;
  return whole ? `${shows} Another request's digits end in ${device.digits.slice(3)} too, so type all six (${device.digits}) to approve, or press Enter to decline: `
    : `${shows} Type ${device.digits.slice(3)} to approve, or press Enter to decline: `;
}

/**
 * What a line typed at the prompt of the request that shows `digits` answers. Only those six digits approve it, with
 * or without the space between the halves, or the last three: a line begun for another request, or typed ahead of
 * any, does not carry this one's digits. With `whole`, only all six do: the last three are another request's too
 * (once in a thousand pairs), and a line typed for that one would carry them. Only an empty line (Enter by itself) declines it. Anything else is no answer
 * (null), a `y` typed out of habit and a mistyped digit among them: a decline ends the request for good, so it is not
 * read into a line that was not one, and the question is asked again. A request whose digits are not six digits is
 * approved by nothing (a bare Enter must never match digits that are missing).
 *
 * install.sh looks for this function by its name (`add_reads_answers`): its `--add` runs the add step only on a
 * release that has it. Keep the words `export function answerOf`.
 */
export function answerOf(line: string, digits: string, whole = false): "approve" | "decline" | null {
  // NFKC first: an input method left in its wide mode types the digits full-width (２２２), and they are the same digits
  const typed = line.normalize("NFKC").replace(/\s/g, "");
  if (typed === "") return "decline";
  if (!SIX_DIGITS.test(digits)) return null;
  return typed === digits || (!whole && typed === digits.slice(3)) ? "approve" : null;
}

function answer(lines: AsyncIterator<string>, signal: AbortSignal): Promise<IteratorResult<string>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    lines.next().then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", stop); reject(error); });
  });
}

const NO_LINES: AsyncIterator<string> = { next: () => Promise.resolve({ value: undefined, done: true }) };

interface Line {
  readonly text: string;
  readonly under: object | null;
  readonly at: number;
}

/**
 * The terminal's lines, read one after another for as long as the waiting lasts. A terminal keeps a line typed while
 * nothing reads and hands it to the next read, so a read begun with a request's prompt would take a line typed before
 * it as that request's answer. With one read always open, every line is taken when it comes and marked with what was
 * asked about just then (`under`), and the one who waits takes them without waiting for one.
 */
function typing(lines: AsyncIterator<string>, signal: AbortSignal, under: () => object | null, now: () => number) {
  const got: Line[] = [];
  let ended = false;
  let failed: unknown;
  let wake: (() => void) | null = null;
  const next = (): void => {
    answer(lines, signal).then((reply) => {
      if (reply.done) ended = true;
      else {
        got.push({ text: reply.value, under: under(), at: now() });
        next();
      }
      wake?.();
    }, (error: unknown) => { failed = error; ended = true; wake?.(); });
  };
  next();
  return {
    take: (): Line[] => got.splice(0),
    get ended() { return ended; },
    get failed() { return failed; },
    arrived: (): Promise<void> => new Promise((resolve) => { if (got.length > 0 || ended) resolve(); else wake = resolve; }),
  };
}

export interface WaitingDevice extends AskingDevice { readonly id: string }

export interface AnswerInput {
  readonly lines: AsyncIterator<string>;
  /**
   * `lines` is a terminal a person types at. Anything else (a pipe, a file, a closed stdin) answers nothing, whenever
   * its lines come: nobody compared the digits a line of `yes | ovis add` arrives under. Unset counts as not one.
   */
  readonly terminal?: boolean;
  /**
   * Discards what the terminal holds and nobody read: the lines sent, and what was typed and not sent. True when it
   * did. Called as a request's prompt first shows, so what was typed before the prompt is no part of its answer.
   * Where there is none, or it fails, the first line after the prompt answers nothing instead.
   */
  readonly discard?: () => boolean;
  readonly out: (text: string) => void;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}

let flush: (() => boolean) | null = null;

/**
 * Discards what the terminal on stdin holds unread, with the system's own tcflush: a line typed and not sent sits in
 * the terminal, not in this process, so nothing here can see or drop it otherwise. False where that cannot be done
 * (Windows, a system whose C library is not found, an input that is no terminal).
 */
export function discardTyped(): boolean {
  try {
    if (flush === null) {
      // TCIFLUSH, the input queue: 0 on Linux, 1 on macOS
      const [queue, libraries] = process.platform === "linux" ? [0, ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`]]
        : process.platform === "darwin" ? [1, ["libSystem.B.dylib"]] : [0, []];
      flush = () => false;
      for (const library of libraries) {
        try {
          const { symbols } = dlopen(library, { tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
          flush = () => symbols.tcflush(0, queue) === 0;
          break;
        } catch {}
      }
    }
    return flush();
  } catch { return false; }
}

/**
 * The one who asks about requests at a terminal, one at a time, and tells which line answers which: `ovis add` and
 * `pair --approve` both ask through it. Only a line typed under the prompt of the request asked about, once that was
 * on the screen long enough to compare its digits (DWELL_MS), answers it. Every other line is dropped and said to
 * be, and none of them is ever kept for a later request.
 *
 * The terminal is read a line at a time (canonical mode), so when a line was begun is not seen, only when its Enter
 * came. What that leaves open is closed from outside: what the terminal holds is discarded as a request's prompt
 * first shows (`discard`), and the first line handed over after a request left the screen, after an answer was lost,
 * or after a prompt whose terminal could not be emptied, answers nothing (`held`). The cost: digits typed before a
 * prompt are discarded though the screen still shows them, so an Enter pressed at it is an empty line and declines
 * (docs/relay.md says so). What remains: keys pressed in
 * the moment after a prompt showed, before the person read it, are part of the line sent at it. Such a line
 * approves only if it is that request's own digits, and declines only if it is empty.
 */
function asking(input: AnswerInput) {
  const { out } = input;
  const now = input.now ?? Date.now;
  const terminal = input.terminal === true;
  // the request asked about: one at a time. `shownAt`: when its prompt, with its digits, first was on the screen
  // `whole`: only all six of its digits approve it, from the start or since another request showed the same last three (`beside`)
  let open: { readonly id: string; readonly label: string; readonly digits: string; readonly device: WaitingDevice; whole: boolean; prompt: string; shownAt: number | null } | null = null;
  const seen = new Map<string, string>();
  let reply: "approve" | "decline" | null = null;
  let three = false;
  let atPrompt = false;
  // A request left the screen unanswered. The terminal hands a line over only when Enter is pressed, and it is
  // marked then: what was typed at that request's prompt and not sent comes with the next Enter, under whatever
  // is asked by then. So the next line handed over answers nothing, whenever it comes and whatever it says.
  // The same after an answer the server did not take (`lost`), and after a prompt shown at a terminal whose input
  // could not be discarded (`show`). Its value: why that line is dropped
  let held: string | null = null;
  const emptied = (): boolean => { try { return input.discard?.() === true; } catch { return false; } };
  // What is not a terminal is never read: it has ended, as far as answers go
  const keys = typing(terminal ? input.lines : NO_LINES, input.signal, () => open !== null && open.shownAt !== null ? open : null, now);
  let endSaid = !terminal;
  if (endSaid) out("This is not run in a terminal, so no request can be answered here: each is declined as it shows. Run this in a terminal to approve one (over ssh, run ssh -t).\n");
  const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
  // The lines that came since the last look: the first after a request went away unanswered (`held`), one typed while
  // nothing was asked, before the prompt showed, or right as it did (a key pressed twice) answers nothing
  const sort = (): void => {
    let dropped: string | null = null;
    for (const line of keys.take()) {
      atPrompt = false;
      if (held !== null) {
        dropped = `${held}${open === null ? "" : " Answer again for the request shown now."}`;
        held = null;
        continue;
      }
      if (open !== null && line.under === open && open.shownAt !== null) {
        if (line.at - open.shownAt >= DWELL_MS) {
          if (reply !== null) continue;
          reply = answerOf(line.text, open.digits, open.whole);
          three = reply === "approve" && answerOf(line.text, open.digits, true) === null;
          // neither the digits nor Enter by itself: it declines nothing, and the question is asked again
          if (reply === null) {
            const typed = line.text.normalize("NFKC").replace(/\s/g, "");
            // Digits of another value, well formed: the strongest sign that this request is not the device the person
            // holds. It is said in so many words, with what declines, since the prompt shown again names this
            // request's digits and typing those approves it. (With `whole`, its own last three are not such a line.)
            dropped = SIX_DIGITS.test(open.digits) && /^(?:[0-9]{3}|[0-9]{6})$/.test(typed) && typed !== open.digits.slice(3)
              ? `${typed} are not this request's digits: ${open.label} shows ${open.digits.slice(0, 3)} ${open.digits.slice(3)}. If the device you are adding shows other digits than those, this request is not that device's: press Enter by itself to decline it, and do not type the digits below.`
              : `${!SIX_DIGITS.test(open.digits) ? "this request cannot be approved here" : open.whole ? "only all six digits shown approve this request" : "only the digits shown approve a request"}, and only Enter by itself declines it. Answer again.`;
          }
          continue;
        }
        if (reply === null) dropped = "it came as the request showed, too soon to have compared its digits. Compare them, then answer again.";
        continue;
      }
      dropped = open === null ? "no request is waiting for an answer."
        : "it was typed before the request shown now was asked about. Answer again for that one.";
    }
    if (dropped !== null) say(`That line answered nothing: ${dropped}\n`);
  };
  return {
    say,
    get open(): { readonly id: string; readonly label: string } | null { return open; },
    look(): void {
      sort();
      if (keys.failed !== undefined) throw keys.failed;
      if (keys.ended && !endSaid) {
        endSaid = true;
        say("The terminal's input ended (Ctrl+D): no request can be answered here any more, so each is declined as it shows. Run this again to answer them.\n");
      }
    },
    /**
     * Asks about a request from now on; its prompt goes out with `show`. `waiting`: the requests that wait now. When
     * another of them, or one asked about earlier in this run, shows the same last three digits, a line typed for
     * that one would carry them: this one then asks for all six, and only all six approve it.
     */
    ask(device: WaitingDevice, waiting: readonly WaitingDevice[]): void {
      const others = [...waiting.filter((other) => other.id !== device.id).map((other) => other.digits), ...[...seen].filter(([id]) => id !== device.id).map(([, digits]) => digits)];
      const whole = SIX_DIGITS.test(device.digits) && others.some((digits) => SIX_DIGITS.test(digits) && digits.slice(3) === device.digits.slice(3));
      seen.set(device.id, device.digits);
      open = { id: device.id, label: plainLabel(device.label), digits: device.digits, device, whole, prompt: approvalPrompt(device, whole), shownAt: null };
      reply = null;
    },
    get byThree(): boolean { return open !== null && !open.whole && reply === "approve" && three; },
    /**
     * `waiting`: the requests that wait now. A request asked about with its last three digits is asked about with
     * all six from the moment another one that ends in the same three waits beside it: a line typed for that one
     * would carry them. Three digits typed and not yet sent approve nothing then; all six, or a decline, stand.
     */
    beside(waiting: readonly WaitingDevice[]): void {
      if (open === null || open.whole || !SIX_DIGITS.test(open.digits)) return;
      const shown = open;
      if (!waiting.some((other) => other.id !== shown.id && SIX_DIGITS.test(other.digits) && other.digits.slice(3) === shown.digits.slice(3))) return;
      sort();
      shown.whole = true;
      shown.prompt = approvalPrompt(shown.device, true);
      const taken = reply === "approve" && three;
      if (taken) reply = null;
      if (reply !== null || shown.shownAt === null) return;
      const why = `nother request's digits end in ${shown.digits.slice(3)} too`;
      say(taken ? `That line answered nothing: a${why}, so only all six digits approve ${shown.label} now.\n` : `A${why}: only all six digits approve ${shown.label} now.\n`);
    },
    /** The request asked about ran out, was answered elsewhere, or the server restarted: its prompt ends, and so does a line typed for it. */
    gone(): void {
      if (open === null) return;
      const shown = open;
      say(`${shown.label} is no longer waiting.\n`);
      open = null;
      reply = null;
      sort();
      // what was typed at its prompt and not sent is still in the terminal: the next line handed over is dropped
      if (shown.shownAt !== null) held = "a request went away while it may have been typed.";
    },
    /**
     * The answer just taken did not reach the PC's server, or whether it did is not known. Until that was said, the
     * person may have typed on, for that request or the one they expected next: the next line handed over answers
     * nothing, whichever request is asked about by then (that one again, or another when the server took the answer).
     */
    lost(): void {
      held = "the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile.";
    },
    get ended(): boolean { return keys.ended; },
    show(): void {
      sort();
      if (open !== null && !atPrompt && reply === null) {
        if (open.shownAt === null) {
          // What was typed before this prompt and not sent would come with the Enter pressed at it: it is discarded
          // now, once for a request (what is typed under its prompt stays when the prompt is shown again). Where it
          // cannot be, the first line after the prompt may have been begun before it, and answers nothing
          if (terminal && !keys.ended && !emptied()) held ??= "this terminal's input could not be emptied as the request showed, so it may have been begun before that.";
          open.shownAt = now();
        }
        out(open.prompt);
        atPrompt = true;
      }
    },
    get answered(): boolean { return open !== null && open.shownAt !== null && (reply !== null || keys.ended); },
    /**
     * The answer to the request asked about, which is then asked about no more: what was typed at its prompt
     * (`answerOf`); an input that ended (Ctrl+D), or is no terminal, declines.
     */
    answer(): { readonly id: string; readonly label: string; readonly decision: "approve" | "decline" } | null {
      if (open === null || open.shownAt === null || (reply === null && !keys.ended)) return null;
      const { id, label } = open;
      const decision = reply ?? "decline";
      open = null;
      reply = null;
      atPrompt = false;
      return { id, label, decision };
    },
    arrived: keys.arrived,
  };
}

export interface ApproveOptions extends AnswerInput {
  readonly decide: (id: string, decision: "approve" | "decline") => Promise<"taken" | "gone" | "away">;
  /**
   * The requests that wait now (`GET /api/relay/pairings`), read again before an approval typed as the last three
   * digits is sent: one that came since the command started may end in the same three. It throws when the PC's
   * server gives no answer. Without it, only the requests the command started with are compared.
   */
  readonly list?: () => Promise<readonly WaitingDevice[]>;
}

/**
 * `pair --approve`: asks about each request that waits, one by one, as `ovis add` does (`asking`): a line counts only
 * for the request whose prompt it was typed under, and only once that was on the screen long enough to compare its
 * digits, so a line typed ahead or twice answers none of the requests that follow. The exit code.
 */
export async function approveWaiting(pairings: readonly WaitingDevice[], options: ApproveOptions): Promise<number> {
  const { out, signal } = options;
  // What is not a terminal answers nothing, so nothing is sent for it either: the requests keep waiting, the person's
  // own phone among them, for a run at a terminal or the app. (A decline ends a request for good; `ovis add --approve`,
  // whose run opened the window those requests came through, declines them as they show.)
  if (options.terminal !== true) {
    out("This is not run in a terminal, so no request can be answered here. Nothing was declined: the requests keep waiting. Run this in a terminal to answer them (over ssh, run ssh -t).\n");
    return 1;
  }
  const desk = asking(options);
  for (const pairing of pairings) {
    desk.ask(pairing, pairings);
    for (;;) {
      desk.look();
      // Three digits approve a request only while no other waiting one ends in them: one may have come since the
      // command read the list, so it is read once more before such an approval is sent (as `ovis add --approve` does)
      if (desk.byThree && options.list !== undefined) {
        let waiting: readonly WaitingDevice[] | null = null;
        try { waiting = await options.list(); } catch {}
        if (waiting === null) {
          // not known whether another request shares them: the three digits approve nothing, and it is asked again
          out(`The waiting requests could not be read again just now, so the last three digits approved nothing. ${plainLabel(pairing.label)} is asked about again.\n`);
          desk.ask(pairing, pairings);
          continue;
        }
        desk.beside(waiting);
      }
      const answer = desk.answer();
      if (answer !== null) {
        const sent = await options.decide(answer.id, answer.decision);
        if (sent === "taken") out(answer.decision === "approve" ? "Approved.\n" : "Declined.\n");
        else if (sent === "gone") out(`${answer.label} is no longer waiting.\n`);
        else {
          if (desk.ended) { out("Your answer may not have reached the Ovis on this PC. Run this again once it answers.\n"); return 1; }
          // asked about again, never answered by itself, and not by a line typed meanwhile
          out(`Your answer may not have reached the Ovis on this PC. ${answer.label} is asked about again.\n`);
          desk.lost();
          desk.ask(pairing, pairings);
          continue;
        }
        break;
      }
      desk.show();
      if (desk.answered) continue;
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        if (signal.aborted) { stop(); return; }
        signal.addEventListener("abort", stop, { once: true });
        desk.arrived().then(() => { signal.removeEventListener("abort", stop); resolve(); });
      });
    }
  }
  return 0;
}

const groups = (id: string): string => id.match(/.{1,4}/g)?.join(" ") ?? id;

export function linkSettings(env: Readonly<Record<string, string | undefined>>): Pick<LinkOptions, "preview" | "cliName" | "app"> {
  const cliName = env["OVIS_CLI_NAME"];
  const app = env["OVIS_RELAY_APP_URL"];
  return { preview: fleetPreview(env), ...cliName ? { cliName } : {}, ...app ? { app } : {} };
}

function cli(options: LinkOptions): string {
  return (options.preview === true && options.cliName) || "ovis";
}

/**
 * One line typed at the terminal in answer to `prompt`; null when none can come (the input ended). What was typed
 * before the prompt is discarded as it shows, and a line that comes too soon after it to have been read (DWELL_MS: one
 * typed ahead where the input cannot be discarded, or a key pressed twice) answers nothing, and the prompt is shown
 * again. For a run that reads nothing else meanwhile: it reads one line at a time, and leaves no read open.
 */
async function askLine(options: LinkOptions, prompt: string): Promise<string | null> {
  const now = options.now ?? Date.now;
  // Where the terminal's input cannot be emptied (Windows, no C library found), a line begun before the prompt comes
  // with the first Enter pressed at it, however late: that first line answers nothing, as `asking` does for a request
  let held = (() => { try { return options.discard?.() !== true; } catch { return true; } })();
  let shownAt = now();
  options.out(prompt);
  for (;;) {
    const reply = await answer(options.lines, options.signal);
    if (reply.done) { options.out("\n"); return null; }
    if (held) {
      held = false;
      shownAt = now();
      options.out(`That line answered nothing: this terminal's input could not be emptied as the question showed, so it may have been typed before it. Answer again.\n${prompt}`);
      continue;
    }
    if (now() - shownAt >= DWELL_MS) return reply.value;
    shownAt = now();
    options.out(`That line answered nothing: it came before the question could be read. Answer again.\n${prompt}`);
  }
}

const PROVIDER_NAMES: Readonly<Record<AccountProvider, string>> = { github: "GitHub", google: "Google", apple: "Apple" };

function appHost(options: LinkOptions, url: string): string {
  if (options.preview !== true) return "app.ovis.sh";
  try { return new URL(url.includes("://") ? url : `https://${url}`).host; } catch { return url; }
}

const remaining = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

async function linkWithCode(options: LinkOptions, api: Api): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  await relayOnline(options, api);
  // the code this run made, as its answers named it: only that one is taken back, not one started since. A refusal of
  // both made nothing, and leaves whatever is pending alone
  let mine: Mine | null = null;
  try {
    for (;;) {
      // the code first: it starts a new pairing, which the offer then carries (RelayPanel CompactRelay);
      // the offer comes whether the code did or not, since its QR code still pairs
      let code: ({ code: string; expires_at: string; server_id: string } & ForAccount) | null = null;
      let refused = "";
      let offer: { url: string; expires_at: string } & ForAccount;
      try {
        try {
          code = await api<{ code: string; expires_at: string; server_id: string } & ForAccount>("POST", "/api/relay/code");
          // this run's from here on, by its id. One from an Ovis that names none is told only by the QR code that carries it
          mine = mineOf(undefined, code.pairing?.id);
        } catch (error) {
          if (!(error instanceof LocalError) || onMachine(error)) throw error;
          refused = error.reason;
        }
        // the QR code carries this round's code while it is pending, else one of its own: never one made elsewhere
        offer = await api<{ url: string; expires_at: string } & ForAccount>("POST", "/api/relay/offer", { headers: { "x-ovis-pairing": code?.pairing?.id ?? "new" } });
      } catch (error) {
        if (!onMachine(error)) throw error;
        out(`This PC runs the machine profile, which takes devices through its Ovis account, not with a code. Run ${cli(options)} add to add this machine to your Ovis account; every device of that account can then use it.\n`);
        return 1;
      }
      const decoded = decodeOffer(offer.url);
      if (decoded === null) throw new LocalError("The relay's pairing link did not parse.");
      mine = mineOf(decoded.code, offer.pairing?.id) ?? mine;
      // a code to type that the QR code does not carry ended as the QR code was made: it is not shown
      if (code !== null && offer.pairing !== undefined && code.pairing?.id !== offer.pairing.id) {
        code = null;
        refused = "it ended as the QR code was made";
      }
      const until = Math.min(code === null ? Infinity : Date.parse(code.expires_at), Date.parse(offer.expires_at));
      const left = remaining(Math.max(0, until - now()));
      out([
        "",
        ...code !== null
          ? [`Code to type: ${code.code}   (works once, expires in ${left})`, `On the other device, open ${appHost(options, offer.url)}, choose Pair with a code and type it,`, "or scan this QR code with the phone's camera:"]
          : [`No code to type this time (${refused}).`, `Scan this QR code with the phone's camera (expires in ${left}):`],
        "",
        qr(offer.url),
        `That device then shows an ID: pair only if it matches this PC's ID, every group: ${groups(code?.server_id ?? decoded.server_id)}`,
        "A new one comes when this one runs out. Press Ctrl+C to stop.",
        "",
      ].join("\n"));
      await wait(Math.max(1_000, until - now()), signal);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (mine !== null) await takeBack(api, out, mine);
  }
  return 0;
}

/**
 * Takes back what --code made, however it ends (Ctrl+C, an error): the six-digit code the QR code
 * carries, and with it the typed code bound to it. With a signal of its own, since Ctrl+C aborted the
 * command's. `mine` names the pairing it made, so one started since (in Settings, on another device)
 * stays.
 */
async function takeBack(api: Api, out: (text: string) => void, mine: Mine): Promise<void> {
  const ended = await endCode(api, mine);
  if (ended === "both") out("Stopped: the code and the QR code no longer work.\n");
  else if (ended === "gone") out("Stopped: the code had already ended on this PC.\n");
  else if (ended === "typed") out("Stopped: the code no longer works. The QR code works until it runs out, as this Ovis cannot take it back.\n");
  else out(`Stopped, but taking the code back was not confirmed (${ended.failed}): it may work until it runs out.\n`);
}

async function endCode(api: Api, mine: Mine): Promise<"both" | "gone" | "typed" | { readonly failed: string }> {
  const signal = AbortSignal.timeout(5_000);
  try {
    const answer = await api<{ cancelled?: boolean }>("POST", "/api/devices/pair/cancel", { signal, body: mine });
    return answer.cancelled === false ? "gone" : "both";
  } catch (error) {
    try {
      if (!(error instanceof LocalError && error.status === 404)) throw error;
      await api("POST", "/api/relay/code/cancel", { signal });
      return "typed";
    } catch (failure) {
      return { failed: failure instanceof Error ? failure.message : String(failure) };
    }
  }
}

interface Listing { readonly serverId: string; readonly entry: { label: string; public_key: string; relay: string } }

/**
 * Lists this PC in the account with its relay key, which opens the approve-here window (addThisPc.ts
 * listThisPc). An entry about to stop showing as new is listed anew: the service keeps `added_at`
 * over a PUT, so only a DELETE then a PUT shows the card again. The entry is `unlisted.listing` from
 * before that DELETE (whose answer can be lost after the service applied it) until the PUT lands: the
 * caller lists it again until it is back, so a renewal never leaves the PC unlisted.
 */
async function listThisPc(api: Api, service: AccountService, now: () => number, unlisted: { listing: Listing | null }): Promise<Listing> {
  const listing = await openedListing(api);
  const listed = (await service.listPcs()).find((pc) => pc.server_id === listing.serverId);
  if (listed === undefined || now() - Date.parse(listed.added_at) < NEW_PC_MS - RELIST_MS) {
    await service.putPc(listing.serverId, listing.entry);
    unlisted.listing = null;
    await nameRelayAccount(api, service);
    return listing;
  }
  unlisted.listing = listing;
  await service.deletePc(listing.serverId);
  if (await putListing(service, listing)) unlisted.listing = null;
  await nameRelayAccount(api, service);
  return listing;
}

async function openedListing(api: Api): Promise<Listing> {
  const { url } = await api<{ url: string }>("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
  const offer = decodeOffer(url);
  if (offer === null) throw new LocalError("This PC's pairing link did not parse.");
  const label = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { serverId: offer.server_id, entry: { label, public_key: publicKey, relay: offer.relay } };
}

/**
 * Tells this PC the account it is listed under, which its relay pass is asked under (docs/relay.md,
 * "Relay pass"). An Ovis from before relay passes has no such route; this runs again with every relist.
 */
async function nameRelayAccount(api: Api, service: AccountService): Promise<void> {
  const session = await service.session();
  if (session) await api("POST", "/api/account/relay-account", { body: { account: session.account } }).catch(() => undefined);
}

async function putListing(service: AccountService, listing: Listing): Promise<boolean> {
  try { await service.putPc(listing.serverId, listing.entry); return true; } catch { return false; }
}

const shortId = (account: string): string => plainLabel(account).slice(0, 12);

interface Device {
  readonly id: string; readonly label: string; readonly created_at: string; readonly via_relay?: true; readonly account?: string;
  /** on a member another member brought in: that member's id. A member without it linked itself */
  readonly added_by?: string;
}

/**
 * Who put this PC in `account`: the member that linked itself, never a device that only holds the code, nor one of
 * the account's devices that member then brought in (`added_by`), whose rows are the newer ones. The one that came
 * since `known` was read; without one, the one paired before (it linked itself meanwhile). Null when that is not one
 * device: no row is a member, several linked themselves, or this Ovis does not tell who brought a member in.
 */
function addedBy(devices: readonly Device[], known: ReadonlySet<string>, account: string): Device | null {
  const linked = devices.filter((device) => device.account === account && device.added_by === undefined);
  const came = linked.filter((device) => !known.has(device.id));
  const one = came.length > 0 ? came : linked;
  return one.length === 1 ? one[0]! : null;
}

const labels = (devices: readonly Device[]): string => devices.map((device) => plainLabel(device.label)).join(", ");

/** What became of a device whose removal was asked for: `joined` when the account that signed in vouches for it by now, so it stays. */
interface Outcome { readonly device: Device; readonly result: "removed" | "gone" | "joined" | { readonly failed: string } }

function removals(outcomes: readonly Outcome[], unkept: boolean): string {
  const removed = outcomes.filter(({ result }) => result === "removed").map(({ device }) => device);
  const one = removed.length === 1;
  return [
    ...removed.length === 0 ? [] : [` ${labels(removed)} paired with this PC since the code was shown and ${one ? "was" : "were"} removed${unkept ? `: nobody kept ${one ? "it" : "them"}` : ""}.`],
    ...outcomes.flatMap(({ device, result }) => typeof result === "string" ? [] : [` ${plainLabel(device.label)} could not be removed (${result.failed}): revoke it in Settings → Devices and PCs on this PC.`]),
  ].join("");
}

interface Joining {
  readonly signedIn: string;
  readonly status: () => Promise<{ account: string | null; enrolling?: boolean }>;
  /** `--print`, or no terminal: the QR code is written as lines that stay, not on a screen of its own */
  readonly plain: boolean;
  readonly unlist: () => Promise<boolean>;
  /** names the account that signed in as the one this PC's relay pass is asked under, whatever was named since */
  readonly name: () => Promise<void>;
  readonly tend: () => Promise<void>;
}

/**
 * The end of `add`: one QR code (and its code to type) that a device signed in to the account scans. That device is
 * paired by the code alone, links itself as this PC's first member, lists the PC and enrolls it
 * (src/lib/relay/accountController.ts): nothing is approved here. So the code is a key to this PC, and is kept like
 * one: on a screen of its own that goes when a device got in, when the run stops and on Ctrl+C; taken back however
 * the run ends; three codes at most; and never shown again once a device paired. It ends well only once this PC is
 * in the account that signed in, with that account's other devices in, and names the device that added it.
 *
 * The code is asked for for the account that signed in (`x-ovis-expect-account`; docs/account.md, "A code made for an
 * account"), and is taken only when the PC's answer repeats that account. A device that pairs with such a code is in
 * no list until it linked itself into that account (one of another account, or signed in to none, is turned away),
 * and the PC ends the code itself once it is in the account: so a device that shows in the list did not come by that
 * code, and ends nothing. The code's id tells, at every look, whether it is still the pending one; one that ended
 * otherwise ends the run, which says why. With an older Ovis on this PC the command says so on each QR code's screen
 * (once with --print), and keeps what follows.
 *
 * The code admits whoever holds it, through the relay or at this PC's own address, so every device that came since
 * the first code is one it let in. One whose row names the account that signed in here is taken as that account's:
 * it is not asked about. That is the device's own word, not a proof: the first member of an account on a PC links
 * itself, by a record its own key signed, and names its account in it (docs/account.md, rule 4), and the account
 * service keeps no device keys to check that against (rule 7). A changed client that learned the account's id could
 * so pass as its device (docs/account.md, "What this does not protect against"). Any other device is named and asked
 * about, and removed unless the person types keep,
 * whether or not this PC joined that account meanwhile by another device. Nothing else keeps one: a run that ends
 * with such a device unanswered for (Ctrl+C, a SIGTERM, the terminal closing, the 30 minutes, an error) removes it.
 * A PC that ended in another account than the one that signed in was put there by a device the code let in, which
 * anyone signed in to any account can be: every device that came since the first code is then removed without a
 * question, that account's members among them, since a PC with no screen has no other place to revoke them. Each
 * look reads the account and the devices before a code is renewed, so no code is made once a device got in.
 */
async function addByQr(options: LinkOptions, api: Api, joining: Joining): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const devices = async (within?: AbortSignal): Promise<Device[]> => (await api<{ devices: Device[] }>("GET", "/api/devices", within === undefined ? {} : { signal: within })).devices;
  const startedAt = now();
  const stopAt = startedAt + WAITING_MS;
  // the window the listing opened is for approving here, which this way does not do: nothing is taken through it.
  // A server that does not answer just now keeps it for its ten minutes, in which nothing is approved here either
  await api("POST", "/api/relay/link/close").catch((error: unknown) => { if (signal.aborted || !(error instanceof LocalError || error instanceof AwayError)) throw error; });
  // the devices this PC had before any code was shown: no code is shown until they are known
  let known: ReadonlySet<string>;
  for (;;) {
    try { known = new Set((await devices()).map((device) => device.id)); break; } catch (error) {
      if (signal.aborted || !(error instanceof AwayError) || now() >= stopAt) throw error;
      await wait(POLL_MS, signal);
    }
  }
  let minted = 0;
  let mine: Mine | null = null;
  // the last look read that code as live: a device that paired with it in time may still be linking, so it is neither
  // renewed nor taken back for the 30 minutes until it is not
  let linking = false;
  // this PC makes its codes for the account that signed in (`ForAccount`), and the id of the one out; `lost`: the id of
  // one this PC no longer knew, which was said. `older`: an Ovis from before that, said once with --print (each of
  // its QR codes says it on its own screen otherwise)
  let tied = false;
  let pinned: string | null = null;
  let lost: string | null = null;
  let older = false;
  const forAccount = { headers: { "x-ovis-expect-account": joining.signedIn } };
  let card: { readonly url: string; readonly typed: string | null; readonly refused: string; readonly serverId: string; readonly until: number } | null = null;
  let screen = false;
  let drawnFor = "";
  let atPrompt = false;
  const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
  const sizeNow = () => joining.plain ? null : options.size?.() ?? null;
  const draw = (): void => {
    if (card === null) return;
    const size = sizeNow();
    drawnFor = size === null ? "" : `${size.columns}x${size.rows}`;
    const left = remaining(Math.max(0, card.until - now()));
    const code = qr(card.url).replace(/\n+$/, "").split("\n");
    const width = Math.max(...code.map((row) => row.length));
    const head = ["Scan this QR code with a device that is signed in to this Ovis account. It adds this PC to the account; there is no number to type.", ...!tied && !joining.plain ? [OLDER_PC] : [], ""];
    const tail = [
      ...card.typed !== null
        ? [`Code to type: ${card.typed}   (works once, expires in ${left})`, `Or, on that device, open ${appHost(options, card.url)}, choose Pair with a code and type it.`]
        : [`No code to type this time (${card.refused}). The QR code expires in ${left}.`],
      `That device then shows an ID: pair only if it matches this PC's ID, every group: ${groups(card.serverId)}`,
      "Anyone who can read this screen can pair with this PC while the code is shown.",
      `${minted < MAX_CODES ? "A new one comes when this one runs out. " : ""}Press Ctrl+C to stop.`,
    ];
    const rows = (lines: readonly string[], columns: number): number => lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
    // the other screen keeps nothing that scrolled off it: a code that does not fit is not drawn until the window grew
    const fits = size === null || (size.columns >= width && size.rows > rows(head, size.columns) + code.length + rows(tail, size.columns));
    const text = [...head, ...fits ? code : [`This window is too small for the QR code (it needs ${width} columns and ${code.length + head.length + tail.length + 1} rows). Make it larger and the code is drawn, or type the code.`, ""], ...tail];
    if (joining.plain) { out(["", ...text, ""].join("\n")); return; }
    out(`${screen ? "" : SCREEN_ON}${SCREEN_CLEAR}${text.join("\n")}\n`);
    screen = true;
  };
  // A terminal that went away (its window closed, the ssh session dropped) takes no write, and one that fails can
  // end the process on the spot (plugin.ts). So as a run ends, what it owes this PC comes before any word: the code is
  // taken back (`retract`) and the devices nobody kept are removed (`sweep`), and only then is the screen left
  // (`leave`) and anything said, by a write that may fail (`tell`)
  const tell = (text: string): void => { try { say(text); } catch {} };
  const retract = async (): Promise<Awaited<ReturnType<typeof endCode>> | null> => {
    card = null;
    if (mine === null) return null;
    const owned = mine;
    mine = null;
    return await endCode(api, owned);
  };
  const leave = (ended: Awaited<ReturnType<typeof retract>>, used: boolean): void => {
    if (screen) {
      screen = false;
      try { out(SCREEN_OFF); } catch {}
    }
    if (ended === null) return;
    if (ended === "both") { if (!used) tell("The code and the QR code no longer work.\n"); }
    else if (ended === "gone") { if (!used) tell("The code had already ended on this PC.\n"); }
    else if (ended === "typed") tell("The code no longer works. The QR code works until it runs out, as this Ovis cannot take it back.\n");
    else tell(`Taking the code back was not confirmed (${ended.failed}): it may work until it runs out.\n`);
  };
  /** The code back from the PC, then off the screen: once a device got in (`used`), or however the run ends. */
  const end = async (used: boolean): Promise<void> => leave(await retract(), used);
  /** A refusal that started no code (NO_CODE_STARTED), in a sentence of its own when this command sent what was refused. */
  const refusal = (error: LocalError): LocalError => error.code === "pairing_gone"
    ? new LocalError(`Another pairing code was made on this PC (in Settings, by ${cli(options)} pair, or by another run) after this run's: it is left as it is, and no QR code is shown. Run ${cli(options)} add again.`, error.status, error.code)
    : error.code !== "invalid_account" ? error
    : new LocalError(`The Ovis on this PC did not take the id of the account you signed in to (${shortId(joining.signedIn)}) for its code (${error.message})`, error.status, error.code);
  const mint = async (): Promise<void> => {
    minted++;
    pinned = null;
    let typed: ({ code: string; expires_at: string; server_id: string } & ForAccount) | null = null;
    let refused = "";
    try { typed = await api<{ code: string; expires_at: string; server_id: string } & ForAccount>("POST", "/api/relay/code", forAccount); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      // nothing was started, and the code pending stays as it was: neither taken back here nor counted as this round's
      if (NO_CODE_STARTED.has(error.code)) throw refusal(error);
      refused = error.reason;
    }
    // the typed code is this run's from here on, and is taken back by its id however the run ends, shown or not. One
    // from an Ovis that names none is told only by the QR code that carries it
    const made = typed?.pairing?.id;
    if (made !== undefined) mine = { id: made };
    // the QR code carries this round's typed code, named by its id, else a fresh one (`x-ovis-pairing`). An id no
    // longer pending (another run, Settings or `ovis pair` made a code since) is refused, and nothing is started
    let offer: { url: string; expires_at: string } & ForAccount;
    try {
      offer = await api<{ url: string; expires_at: string } & ForAccount>("POST", "/api/relay/offer", { headers: { ...forAccount.headers, "x-ovis-pairing": made ?? "new" } });
    } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      // the offer started nothing of its own: this round's typed code, or the code shown before, is what stays to take back
      throw refusal(error);
    }
    const decoded = decodeOffer(offer.url);
    if (decoded === null) throw new LocalError("The relay's pairing link did not parse.");
    // The QR code's code is shown and taken back only when the PC's answer names it as the code asked for: this round's
    // typed code, or with none a fresh one. Any other is left as it is. An older Ovis names none: its code is shown
    // with OLDER_PC, and taken back by its six digits
    const own = offer.pairing === undefined ? made === undefined : made === undefined || offer.pairing.id === made;
    if (!own) throw new LocalError(`This PC's QR code carries a code made elsewhere (in Settings, by ${cli(options)} pair, or by another run): it is not shown, and is left as it is. Run ${cli(options)} add again.`);
    mine = mineOf(decoded.code, offer.pairing?.id) ?? mine;
    offered = true;
    // the QR code's code is the one the PC made for the account that signed in, or one from an older Ovis
    tied = offer.expect_account !== undefined;
    for (const answer of [offer, typed]) {
      if (answer?.expect_account !== undefined && answer.expect_account !== joining.signedIn) {
        throw new LocalError(`The Ovis on this PC made its code for another Ovis account (${shortId(answer.expect_account)}) than the one you signed in to (${shortId(joining.signedIn)}). Run ${cli(options)} add again.`);
      }
    }
    pinned = offer.pairing?.id ?? null;
    if (!tied && !older && joining.plain) {
      older = true;
      say(`${OLDER_PC}\n`);
    }
    card = { url: offer.url, typed: typed?.code ?? null, refused, serverId: typed?.server_id ?? decoded.server_id, until: Math.min(typed === null ? Infinity : Date.parse(typed.expires_at), Date.parse(offer.expires_at)) };
    draw();
  };
  // a device got in, or this PC joined an account: from then on no code is shown again, whatever becomes of that device
  let over = false;
  let offered = false;
  const seen = new Map<string, number>();
  const settled = new Set<string>();
  let unremoved = false;
  let account: string | null = null;
  let strays: Device[] = [];
  /**
   * The devices the code let in that nobody vouched for: not in `known`, not answered for, and no member of the
   * account that signed in. A row tells its own account, so one that linked itself counts as a member from the list
   * alone, also when the account was read before it did. That account is what the device named when it linked
   * itself, which nothing here can check (see above). A member of any other account is vouched for by nobody here.
   */
  const unvouched = (list: readonly Device[]): Device[] => list.filter((device) => !known.has(device.id) && !settled.has(device.id) && device.account !== joining.signedIn);
  /**
   * Removes devices nobody vouched for, each unless the account that signed in vouches for it by now
   * (`x-ovis-unless-account`, which the PC checks as it removes): one that linked itself since the list was read
   * stays. `within`: as the run ends, with a signal of its own (Ctrl+C aborted the command's); nothing is thrown then.
   */
  const remove = async (targets: readonly Device[], within?: AbortSignal): Promise<Outcome[]> => {
    const outcomes: Outcome[] = [];
    for (const device of targets) {
      try {
        await api("DELETE", `/api/devices/${encodeURIComponent(device.id)}`, { headers: { "x-ovis-unless-account": joining.signedIn }, ...within === undefined ? {} : { signal: within } });
        outcomes.push({ device, result: "removed" });
      } catch (error) {
        if (within === undefined && signal.aborted) throw error;
        if (error instanceof LocalError && error.status === 404) outcomes.push({ device, result: "gone" });
        else if (error instanceof LocalError && error.code === "account_member") outcomes.push({ device, result: "joined" });
        else outcomes.push({ device, result: { failed: error instanceof Error ? error.message : String(error) } });
      }
    }
    return outcomes;
  };
  const listed = async (within?: AbortSignal): Promise<Device[] | { readonly unread: string }> => {
    for (let attempt = 1; ; attempt++) {
      try { return await devices(within); } catch (error) {
        if (within === undefined && signal.aborted) throw error;
        const unread = error instanceof Error ? error.message : String(error);
        if (attempt >= CLEAR_READS) return { unread };
        try { await wait(CLEAR_RETRY_MS, within ?? signal); } catch (stopped) {
          if (within === undefined) throw stopped;
          return { unread };
        }
      }
    }
  };
  /**
   * Removes every device nobody vouched for, without a question, looking again until none is left: one that took the
   * code just before it was taken back shows only now, and a member of another account brings that account's other
   * devices in meanwhile. `from`: the devices as just read; null reads them. `open`: why it cannot be told that none
   * is left, null when the last read showed none. The devices could not be read (`unread`; those of the last look
   * are removed all the same), or more kept coming than it looks again for (`more`).
   */
  const clear = async (from: readonly Device[] | null, within?: AbortSignal): Promise<{ readonly outcomes: Outcome[]; readonly open: { readonly unread: string } | "more" | null }> => {
    const outcomes: Outcome[] = [];
    const tried = new Set<string>();
    let list = from;
    let open: { readonly unread: string } | "more" | null = null;
    for (let round = 0; ; round++) {
      if (list === null) {
        const read = await listed(within);
        if (Array.isArray(read)) {
          list = read;
          open = null;
        } else {
          open = read;
          if (round > 0) break;
          list = strays;
        }
      }
      const targets = unvouched(list).filter((device) => !tried.has(device.id));
      if (targets.length === 0) break;
      if (round >= CLEAR_ROUNDS) {
        open = "more";
        break;
      }
      for (const device of targets) tried.add(device.id);
      outcomes.push(...await remove(targets, within));
      list = null;
    }
    return { outcomes, open };
  };
  let asking = null as { readonly key: string; readonly devices: readonly Device[]; readonly prompt: string; readonly alone: boolean; shownAt: number | null } | null;
  let keys: ReturnType<typeof typing> | null = null;
  let reply = null as string | null;
  let added = false;
  let enrollingSaid = false;
  let parting: string | null = null;
  let away = false;
  let codeless: "relay" | "away" | null = null;
  // A question left the screen unanswered (other devices to ask about, this PC joined an account, or the device became
  // a member). The terminal hands a line over only when Enter is pressed: what was typed at that question and not
  // sent comes with the next Enter, under whatever is asked by then. So the next line handed over answers nothing,
  // whenever it comes and whatever it says (as `held` in linkToAccount)
  let held = false;
  // Only a line that came under the question asked, once it was on the screen long enough to read (DWELL_MS), answers
  // it: the terminal is read from the first question on, and hands over then what was typed before it. Every other
  // line is dropped and said to be, and the question is asked again
  const sort = (): void => {
    if (keys === null || asking === null || asking.shownAt === null) return;
    let dropped: string | null = null;
    for (const line of keys.take()) {
      atPrompt = false;
      if (held) {
        held = false;
        dropped = "the question changed while it may have been typed. Answer again for the question shown now.";
        continue;
      }
      if (line.under === asking && line.at - asking.shownAt >= DWELL_MS) reply ??= line.text;
      else if (reply === null) dropped = "it came before the question could be read. Answer again.";
    }
    if (dropped !== null) say(`That line answered nothing: ${dropped}\n`);
  };
  /**
   * As the run ends with devices the code let in unanswered for (Ctrl+C, a SIGTERM, the terminal closing, the 30
   * minutes, an error): they are removed, the ones still in their 15 seconds or never asked about among them. Only
   * the word keep keeps a device nobody vouched for. What is said of it; it never throws.
   */
  const sweep = async (): Promise<string> => {
    const { outcomes, open } = await clear(null, AbortSignal.timeout(SWEEP_MS));
    const left = open === null || !offered ? ""
      : `${open === "more" ? " More devices paired with this PC while these were removed" : ` The devices paired with this PC could not be read as the run ended (${open.unread})`}: one that paired since the code was shown may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours.`;
    return `${removals(outcomes, true)}${left}`;
  };
  /** The run ends unfinished: the code goes back and the devices nobody kept go, then `text` is said, with what went. */
  const stop = async (text: string): Promise<number> => {
    const ended = await retract();
    const swept = await sweep();
    leave(ended, false);
    tell(`${text}${swept}\n`);
    return 1;
  };
  try {
    for (;;) {
      away = false;
      linking = false;
      try {
        sort();
        if (keys !== null && keys.failed !== undefined) throw keys.failed;
        const joined = await joining.status();
        await joining.tend();
        const list = await devices();
        signal.throwIfAborted();
        if (keys !== null && keys.failed !== undefined) throw keys.failed;
        account = joined.account;
        const fresh = list.filter((device) => !known.has(device.id));
        // whoever came since the first code got in with it, through the relay or at this PC's own address. Not by a code
        // made for the account that signed in: a device that pairs with it is in no list until this PC is in that account
        if ((fresh.length > 0 && !tied) || account !== null) {
          over = true;
          await end(true);
        }
        // whether the code made for the account that signed in is still the pending one; it ends by itself as this PC
        // joins an account, and runs out as the card says. Ended otherwise, no device may come by it any more
        if (!over && mine !== null && pinned !== null) {
          const id = pinned;
          const read = await api<{ state: string; ended?: { why?: string } }>("POST", "/api/relay/offer/keep", { body: { id } });
          const why = read.ended?.why ?? "";
          linking = read.state === "live";
          if (read.state === "ended" && why !== "joined" && why !== "expired") {
            mine = null;
            return await stop(`The code no longer works: ${CODE_ENDED[why] ?? "it ended on this PC."} Run ${cli(options)} add again.`);
          }
          if (read.state === "unknown" && lost !== id) {
            lost = id;
            say("The Ovis on this PC no longer knows the code shown (it restarted), so that code does not work. A new one comes when it would have run out.\n");
          }
        }
        for (const device of fresh) {
          if (seen.has(device.id)) continue;
          seen.set(device.id, now());
          if (account === null) say(device.via_relay === true ? `${plainLabel(device.label)} paired with this PC. Waiting for it to add this PC to your account…\n` : `${plainLabel(device.label)} paired with this PC at its own address, not through the relay.\n`);
        }
        strays = unvouched(list);
        const by = account === null ? null : addedBy(list, known, account);
        const label = by === null ? null : plainLabel(by.label);
        if (account !== null && account !== joining.signedIn) {
          // Another account than the one that signed in: a device the code let in put this PC there, or brought a
          // device paired before to do it. Whoever came since the first code goes, with no question: nobody here
          // vouches for that account, and this PC is out of it again once its members here are gone
          const { outcomes, open } = await clear(list);
          const said = `This PC joined another Ovis account (${shortId(account)})${label === null ? "" : `, added by ${label}`}, not the one you signed in to (${shortId(joining.signedIn)}).${removals(outcomes, false)}`;
          // where that leaves this PC. When its devices or its account cannot be read, more of that account's devices
          // may be paired than were removed: that is said, with the way to end them, rather than left to the next run
          let unread = open !== null && open !== "more" ? open.unread : null;
          let left: string | null = account;
          let rows: readonly Device[] = [];
          if (unread === null) {
            try {
              left = (await joining.status()).account;
              rows = await devices();
            } catch (error) {
              if (signal.aborted || !(error instanceof AwayError || error instanceof LocalError)) throw error;
              unread = error.message;
            }
          }
          if (unread !== null) {
            say(`${said} What is paired with this PC now could not be read (${unread}): devices of that account may still be paired. Open Settings → Devices and PCs on this PC and choose Revoke all if that account is not yours.\n`);
            return 1;
          }
          if (left === joining.signedIn) {
            say(`${said}\n`);
            continue;
          }
          if (left === null) {
            // its relay pass is asked under the account that signed in, whatever a member of the other one named
            await joining.name();
            // more kept pairing than was looked again for: the last of them is paired still, and the next run would
            // take it for one this PC had before
            say(open === "more"
              ? `${said} This PC is in no account again, but more devices paired with it while these were removed, and one may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours, then run ${cli(options)} add again.\n`
              : `${said} This PC is in no account again. Run ${cli(options)} add again, and scan the code with a device signed in to the account you signed in to here.\n`);
            return 1;
          }
          // held there by a device paired before this run, or by one that could not be removed. Its relay pass is not
          // pointed at that account from here: a PC's members' account is the one it is asked under anyway
          const holders = rows.filter((device) => known.has(device.id) && device.account === left);
          const unlisted = await joining.unlist();
          say(`${said} This PC is still in that account${holders.length === 0 ? "" : `, by ${labels(holders)}, paired before this run`}. ${unlisted ? "It was taken off the list of the account you signed in to." : "It could not be taken off the list of the account you signed in to; remove it there."} If that account is not yours, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
          return 1;
        }
        if (parting !== null) {
          if (account !== null) parting = null;
          else if (strays.length === 0) {
            say(parting);
            return 1;
          }
        }
        added = account !== null;
        if (added && joined.enrolling === true && !enrollingSaid) {
          enrollingSaid = true;
          say(`Added${label === null ? "" : ` by ${label}`}. Bringing in your account's other devices…\n`);
        }
        // A device that came through the relay gets ALONE_MS to become a member: one that is signed in links itself
        // within seconds. One that paired at this PC's own address cannot be a member, and is asked about at once
        const due = strays.some((device) => device.via_relay !== true || now() - (seen.get(device.id) ?? now()) >= ALONE_MS);
        const key = due ? `${account ?? ""} ${strays.map((device) => device.id).sort().join(" ")}` : null;
        // other devices than the question named, or this PC joined an account meanwhile: it is asked anew, and a line
        // typed for the old one answers nothing. With none left (the device became a member after all) it is dropped
        if (asking !== null && asking.key !== key) {
          const was = asking;
          // what was handed over until now came while the old question was asked, and answers nothing any more. Taken
          // whether or not an answer was among it: a line left there would use up the drop of the one held back (`held`)
          const sent = (keys !== null && keys.take().length > 0) || reply !== null;
          asking = null;
          reply = null;
          if (sent) {
            atPrompt = false;
            say("That line answered nothing: its question is no longer asked.\n");
          }
          // what was typed at the old question and not sent is still in the terminal: the next line handed over is dropped
          if (was.shownAt !== null) held = true;
          if (atPrompt && key !== null) { out("\n"); atPrompt = false; }
        }
        if (asking === null && key !== null) {
          const alone = account === null && strays.every((device) => device.via_relay === true);
          const one = strays.length === 1;
          asking = {
            key, devices: strays, alone, shownAt: null,
            prompt: alone
              ? `${labels(strays)} paired with this PC but ${one ? "has" : "have"} not added this PC to an account yet, so this PC is in no account. Keep ${one ? "that device" : "those devices"}? Type keep to keep ${one ? "it" : "them"}, or press Enter to remove ${one ? "it" : "them"}: `
              : `${labels(strays)} paired with this PC while the code was shown and ${one ? "is" : "are"} not in your account. Keep ${one ? "that device" : "those devices"}? Type keep to keep ${one ? "it" : "them"}, or press Enter to remove ${one ? "it" : "them"}: `,
          };
          // read from here on, not sooner: a run in the background is stopped by its first read of the terminal.
          // What is not a terminal is never read: it answers nothing
          keys ??= typing(options.terminal === true ? options.lines : NO_LINES, signal, () => asking, now);
        } else if (asking !== null && keys !== null && asking.shownAt !== null && (reply !== null || keys.ended || now() >= stopAt)) {
          const asked = asking;
          // no answer (not a terminal, Ctrl+D, or none in time) keeps nothing: nobody vouched for those devices
          // the word itself, typed in full: a y, begun for anything else or by habit, vouches for nobody
          // NFKC first: an input method left in its wide mode types it full-width (ｋｅｅｐ), and it is the same word
          const word = reply === null ? null : reply.normalize("NFKC").trim().toLowerCase();
          const keep = word === "keep";
          if (word !== null && !keep && /^y(es)?$/.test(word)) say(`Only the word keep keeps ${asked.devices.length === 1 ? "it" : "them"}, not y.\n`);
          if (reply === null) say(keys.ended ? `No answer can be typed here, so ${asked.devices.length === 1 ? "it is" : "they are"} not kept.\n` : `No answer came in time, so ${asked.devices.length === 1 ? "it is" : "they are"} not kept.\n`);
          atPrompt = false;
          asking = null;
          reply = null;
          const joined = new Set<string>();
          if (keep) out("Kept.\n");
          else {
            const outcomes = await remove(asked.devices);
            for (const { device, result } of outcomes) {
              const name = plainLabel(device.label);
              if (result === "gone") out(`${name} is no longer paired with this PC.\n`);
              else if (result === "joined") {
                joined.add(device.id);
                out(`${name} is in your account by now, so it stays.\n`);
              } else if (result !== "removed") {
                unremoved = true;
                out(`${name} could not be removed (${result.failed}): revoke it in Settings → Devices and PCs on this PC.\n`);
              }
            }
            if (outcomes.some(({ result }) => result === "removed")) out("Removed.\n");
          }
          for (const device of asked.devices) if (!joined.has(device.id)) settled.add(device.id);
          strays = unvouched(list);
          const parted = asked.alone ? `Sign in on ${asked.devices.length === 1 ? "that device" : "one of those devices"}, then run ${cli(options)} add again.\n` : `This PC is in no account yet. Run ${cli(options)} add again.\n`;
          if (!keep) {
            // Nothing ends on the look taken before a removal. A device that paired, or an account this PC joined,
            // between that look and the DELETE shows only in the next one, which comes at once: the removed device
            // may have linked itself and brought its account's devices in, or passed a code on, as it went
            parting = account === null && joined.size === 0 ? parted : null;
            continue;
          }
          if (account === null) {
            out(parted);
            return 1;
          }
        }
        if (added && joined.enrolling !== true && strays.length === 0) {
          say(`This PC is in your account (${shortId(joining.signedIn)})${label === null ? "" : `, added by ${label}`}: every device of your account can use it.\n`);
          return unremoved ? 1 : 0;
        }
      } catch (error) {
        // a server that is restarting answers again in a moment. One that did restart lost the code it kept in memory:
        // the QR code on the screen is then dead, and the next comes when it would have run out
        if (signal.aborted || !(error instanceof AwayError)) throw error;
        away = true;
      }
      if (now() >= stopAt && !linking) {
        return await stop(added
          ? `Stopped waiting after 30 minutes: this PC is in your account, but its other devices are not in yet. Open the Ovis app on the device that added it, then run ${cli(options)} add again.`
          : `Stopped after 30 minutes. Run ${cli(options)} add again.`);
      }
      // A code only after a look that was answered and found no device and no account: none is made once a device got in,
      // nor while that cannot be told, nor while the code out still holds a device that paired with it in time
      if (!over && !away && !linking && (card === null || now() >= card.until)) {
        if (minted >= MAX_CODES) return await stop(`Stopped after ${Math.max(1, Math.round((now() - startedAt) / 60_000))} minutes. Run ${cli(options)} add again.`);
        try {
          await mint();
          codeless = null;
        } catch (error) {
          if (signal.aborted || !(error instanceof AwayError || (error instanceof LocalError && error.status === 409 && error.code !== "pairing_gone"))) throw error;
          minted--;
          // this PC joined an account meanwhile (`in_account`): the next look finds it there, and asks for no code
          if (!(error instanceof LocalError && error.code === "in_account")) {
            away = true;
            const why = error instanceof LocalError && (error.code === "relay_off" || error.code === "relay_offline") ? "relay" : "away";
            if (codeless !== why) {
              codeless = why;
              say(why === "relay"
                ? "This PC's Ovis relay is off or not online just now, so it gave no code. Asking again…\n"
                : "The Ovis on this PC gave no code just now (is it restarting?). Asking again…\n");
            }
          }
        }
      }
      // a window that changed its size is drawn again: the other screen does not reflow what it cut off
      const size = sizeNow();
      if (screen && (size === null ? "" : `${size.columns}x${size.rows}`) !== drawnFor) draw();
      sort();
      if (asking !== null && !atPrompt && reply === null) {
        if (asking.shownAt === null) {
          // What was typed before this question and not sent would come with the Enter pressed at it: it is discarded
          // now, once for a question (as `asking` does for a request). Where it cannot be, such a line still keeps
          // nothing unless it is the word keep
          if (options.terminal === true && keys !== null && !keys.ended) { try { options.discard?.(); } catch {} }
          asking.shownAt = now();
        }
        out(asking.prompt);
        atPrompt = true;
      }
      const answered = asking !== null && keys !== null && (reply !== null || keys.ended);
      if (asking !== null && keys !== null && !answered) {
        const early = new AbortController();
        const pause = wait(POLL_MS, AbortSignal.any([signal, early.signal]));
        const first = await Promise.race([pause.then(() => "waited" as const), keys.arrived().then(() => "typed" as const)]);
        if (first === "typed") { pause.catch(() => undefined); early.abort(); }
        signal.throwIfAborted();
      } else if (!answered || away) await wait(POLL_MS, signal);
    }
  } catch (error) {
    // Ctrl+C, a SIGTERM, the terminal closing (SIGHUP), or an error: the code is taken back first, then every device
    // it let in that was not answered for goes. Nobody typed keep, and the terminal that could say so may be gone
    if (signal.aborted) return await stop(`Stopped. Run ${cli(options)} add again to add this PC.`);
    const ended = await retract();
    const swept = await sweep();
    leave(ended, false);
    if (swept !== "") tell(`${swept.trimStart()}\n`);
    throw error;
  } finally {
    await end(false);
  }
}

async function linkToAccount(options: LinkOptions, api: Api, forced: DeviceProvider | undefined, mode: { readonly approve: boolean; readonly print: boolean }): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const status = () => api<{ account: string | null; enrolling?: boolean }>("GET", "/api/account/status");
  let first: { account: string | null; enrolling?: boolean };
  try { first = await status(); } catch (error) {
    if (!(error instanceof LocalError && error.status === 404)) throw error;
    out("The Ovis running on this PC is older than link needs. Update it in Settings → Updates (or reinstall the plugin), then run this again.\n");
    return 1;
  }
  if (first.account !== null) {
    if (first.enrolling !== true) {
      out(`This PC is already in an Ovis account (${shortId(first.account)}).\n`);
      return 0;
    }
    out(`This PC is already in an Ovis account (${shortId(first.account)}), but its account's other devices are not in yet. Open the Ovis app on the phone that added it. Waiting for them; press Ctrl+C to stop.\n`);
    const stopAt = now() + WAITING_MS;
    for (;;) {
      await wait(POLL_MS, signal);
      let again: { account: string | null; enrolling?: boolean } | null = null;
      try { again = await status(); } catch (error) {
        if (!(error instanceof AwayError)) throw error;
      }
      if (again !== null && again.account === null) {
        out("This PC is no longer in an account. Run this again to add it.\n");
        return 1;
      }
      if (again !== null && again.enrolling !== true) {
        out(`This PC is in an Ovis account (${shortId(again.account ?? first.account)}): every device of that account can use it.\n`);
        return 0;
      }
      if (now() >= stopAt) {
        out("Stopped waiting after 30 minutes: this PC is in the account, but its other devices are not in yet. Open the Ovis app on the phone that added it, then run this again.\n");
        return 1;
      }
    }
  }
  if (options.accountService === null) {
    out("The account service is off on this PC (OVIS_ACCOUNT_SERVICE_URL=off). Link it with a code instead: run this again with --code.\n");
    return 1;
  }
  // said before the sign-in, not after it: the QR code admits whoever reads it, so it goes to a terminal only
  // (under the fleet preview with --print too, and only once Enter was pressed there under the account's name)
  const preview = options.preview === true;
  if (preview && !mode.approve && (options.isTty !== true || options.terminal !== true)) {
    out(`Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ${cli(options)} add in a terminal (over ssh, run ssh -t).\n`);
    return 1;
  }
  if (!preview && !mode.approve && !mode.print && options.isTty !== true) {
    out("The QR code is a key to this PC. Run this in a terminal, or pass --print to write it anyway.\n");
    return 1;
  }
  await relayOn(options, api);
  const store = memoryAccountStore();
  const lock = memoryLock();
  const serviceFetch = options.serviceFetch ?? fetch;
  const offer = forced === undefined ? await offeredProviders(options.accountService, ["github"], { fetch: serviceFetch }) : null;
  const requester = { label: hostname(), os: accountOsOfPlatform(process.platform) };
  const startOptions = { service: options.accountService, store, lock, fetch: serviceFetch, now, wait, requester };
  const signIn = offer !== null && offer.page.length > 0 ? await startLinkPageSignIn(startOptions, offer.device[0] ?? "github") : await startDeviceSignIn({ ...startOptions, provider: forced ?? offer?.device[0] ?? "github" });
  const provider = signIn.provider;
  out((provider === "ovis"
    ? [
      "",
      "Sign in to your Ovis account:",
      `open ${signIn.verificationUri} on any device and enter the code: ${signIn.userCode}`,
      ...(signIn.verificationUriComplete === null ? [] : ["or scan this QR code with the phone's camera:", qr(signIn.verificationUriComplete)]),
      // a test copy of the service may ask for another sign-in there
      options.accountService === DEFAULT_ACCOUNT_SERVICE ? "Then continue with GitHub or Google there. Waiting for the sign-in…" : "Then sign in there. Waiting for the sign-in…",
      "",
    ]
    : [
      "",
      `Sign in to your Ovis account with ${provider === "github" ? "GitHub" : "Google"}:`,
      `open ${signIn.verificationUri} on any device and enter the code: ${signIn.userCode}`,
      "Waiting for the sign-in…",
      "",
    ]).join("\n"));
  await signIn.finish(signal);
  const service = new AccountService({ store, lock, fetch: serviceFetch, now });
  const session = await service.session();
  const signedIn = session?.account ?? null;
  const pending: { listing: Listing | null } = { listing: null };
  const unlisted = "This PC could not be listed in your account again just now; it is tried again until it is.\n";
  try {
    if (session === undefined || signedIn === null) throw new LocalError("The sign-in did not last. Run this again.");
    if (preview && !mode.approve) {
      // The account as the service's token answer names it: its id and the provider it signed in with (the service
      // keeps no login or email to name it by). It is named before this PC is listed in it or any QR code is shown,
      // and the QR code waits for Enter under that name
      const line = await askLine(options, `Signed in as Ovis account ${signedIn} (signed in with ${PROVIDER_NAMES[session.provider]}). Press Enter to show the QR code for this account's phone, or press Ctrl+C if that is not your account: `);
      if (line === null || line.normalize("NFKC").trim() !== "") {
        out(`The QR code was not shown, and this PC was not listed in that account. Run ${cli(options)} add again and sign in with your own account.\n`);
        return 1;
      }
    }
    const first = await listThisPc(api, service, now, pending);
    if (pending.listing !== null) out(unlisted);
    // a renewal's listing not put back yet goes back first: an account that does not list the PC gives it no pass
    if (pending.listing !== null && await putListing(service, pending.listing)) { pending.listing = null; await nameRelayAccount(api, service); }
    try { await relayOnline(options, api); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      throw new LocalError(`This PC stays listed in your account, but its Ovis relay is not online yet (${error.message}) Run this again once it is.`);
    }
    const name = first.entry.label;
    if (!mode.approve) {
      out(preview ? `This PC is listed in that account as ${name}.\n` : `Signed in. This PC is listed in your account as ${name}.\n`);
      return await addByQr(options, api, {
        signedIn, status, plain: mode.print || options.isTty !== true,
        unlist: () => { pending.listing = null; return service.deletePc(first.serverId).then(() => true, () => false); },
        name: () => nameRelayAccount(api, service),
        tend: async () => { if (pending.listing !== null && await putListing(service, pending.listing)) pending.listing = null; },
      });
    }
    let listedAt = now();
    let openedAt = listedAt;
    const stopAt = listedAt + WAITING_MS;
    // the window is asked for only while it would end by the time this run stops, so it never outlives the 30 minutes
    const mayOpen = () => now() <= stopAt - WINDOW_MS;
    let enrollingSaid = false;
    let added = false;
    let away = false;
    out([
      `Signed in. This PC is listed in your account as ${name}.`,
      `On a device already signed in to this account (the Ovis app or ${appHost(options, options.app ?? "https://app.ovis.sh")}), choose Add on ${name}.`,
      "If it shows Join there instead, choose Join, then Ask to join or Type the number.",
      "Its request shows here to approve. Press Ctrl+C to stop.",
      "",
    ].join("\n"));
    // Read from here on, before anything is asked: a line typed ahead (the terminal kept those of the sign-in) comes
    // now, under no request, and answers none. Not sooner: a run in the background is stopped by its first read of
    // the terminal, and by now the PC is listed and the person was told what to do.
    const desk = asking({ lines: options.lines, ...options.terminal === undefined ? {} : { terminal: options.terminal }, ...options.discard === undefined ? {} : { discard: options.discard }, out, signal, now });
    const { say } = desk;
    const elsewhere = async (account: string): Promise<number> => {
      pending.listing = null;
      const unlistedThere = await service.deletePc(first.serverId).then(() => true, () => false);
      await api("POST", "/api/account/relay-account", { body: { account } }).catch(() => undefined);
      say(`This PC joined another Ovis account (${shortId(account)}), not the one you signed in to (${shortId(signedIn)}). ${unlistedThere ? "It was taken off the list of the account you signed in to." : "It could not be taken off the list of the account you signed in to; remove it there."} If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
      return 1;
    };
    let lastListed = false;
    const lastLooks = () => mayOpen() && now() >= stopAt - WINDOW_MS - LAST_MS;
    const asked = new Set<string>();
    for (;;) {
      try {
        if (away && !added && !mayOpen()) {
          let back: { account: string | null } | null = null;
          try { back = await status(); } catch (error) {
            if (!(error instanceof AwayError)) throw error;
          }
          if (back === null || back.account === null) {
            // a server that restarted has no window, and this run may not open one that would outlive it
            say("The Ovis on this PC stopped answering, too close to this run's 30 minutes to open its approval window again. Run this again once it is back.\n");
            return 1;
          }
          added = back.account === signedIn;
          if (!added) return await elsewhere(back.account);
        }
        desk.look();
        if (away) {
          if (!added) await api("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
          else await status();
          openedAt = now();
          away = false;
          say("The Ovis on this PC answers again.\n");
        }
        // Three digits approve a request only while no other waiting one ends in them: one may have come since the
        // last look, so the list is read once more before such an approval is sent
        if (desk.byThree) desk.beside((await api<{ pairings: WaitingDevice[] }>("GET", "/api/relay/pairings")).pairings);
        const answer = desk.answer();
        if (answer !== null) {
          const { id, label, decision } = answer;
          try {
            await api("POST", "/api/relay/pairing", { body: { id, decision } });
            out(decision === "approve" ? "Approved.\n" : "Declined.\n");
          } catch (error) {
            if (error instanceof AwayError) {
              // whether it was taken is not known: the request is asked about again while it still waits, never answered by itself
              asked.delete(id);
              // nor by a line typed meanwhile, whichever request is asked about next
              desk.lost();
              out(`Your answer may not have reached the Ovis on this PC. ${label} is asked about again if it is still waiting.\n`);
            }
            if (!(error instanceof LocalError)) throw error;
            out(`${label} is no longer waiting.\n`);
          }
        }
        const { pairings } = await api<{ pairings: WaitingDevice[] }>("GET", "/api/relay/pairings");
        const shown = desk.open;
        if (shown !== null && !pairings.some((pairing) => pairing.id === shown.id)) desk.gone();
        // another request that ends in the same three digits waits beside the one asked about: that one asks for all six
        desk.beside(pairings);
        const next = desk.open === null ? pairings.find((pairing) => !asked.has(pairing.id)) : undefined;
        if (next !== undefined) {
          asked.add(next.id);
          desk.ask(next, pairings);
        }
        const joined = await status();
        if (joined.account !== null && joined.account !== signedIn) return await elsewhere(joined.account);
        if (joined.account !== null && joined.enrolling !== true) {
          say(`This PC is in your account (${shortId(joined.account)}): every device of your account can use it.\n`);
          return 0;
        }
        added = joined.account !== null;
        if (added && !enrollingSaid) {
          enrollingSaid = true;
          say("Added. Bringing in your account's other devices…\n");
        }
        // a listing a renewal took away goes back, also once this PC is in the account: unlisted, it gets no relay pass
        if (pending.listing !== null && now() < stopAt && await putListing(service, pending.listing)) pending.listing = null;
        if (!added && now() < stopAt) {
          const last = lastLooks();
          let opened = false;
          if ((now() - listedAt >= RELIST_MS || (last && !lastListed)) && mayOpen()) {
            // a renewal that failed after its DELETE went out keeps waiting: the listing is put back above, as after a failed PUT.
            // None in the last ten minutes: it would show the PC as new for ten more, past the window's end
            try { await listThisPc(api, service, now, pending); } catch (error) {
              if (pending.listing === null) throw error;
            }
            if (pending.listing !== null) say(unlisted);
            listedAt = now();
            openedAt = listedAt;
            opened = true;
            if (last) lastListed = true;
          }
          // every one of the last looks asks too, so the last window ends with the run, not up to 30 seconds before it,
          // whichever of them turns out to be the last in time
          if (!opened && mayOpen() && (now() - openedAt >= REOPEN_MS || last)) {
            await api("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
            openedAt = now();
          }
        }
      } catch (error) {
        if (signal.aborted) { say("Stopped. Run this again to keep waiting.\n"); return 1; }
        if (!(error instanceof AwayError)) throw error;
        if (!away) {
          away = true;
          say("The Ovis on this PC is not answering (is it restarting?). Waiting for it…\n");
        }
      }
      if (now() >= stopAt) {
        say(added
          ? "Stopped waiting after 30 minutes: this PC is in your account, but its other devices are not in yet. Open the Ovis app on the phone that added it, then run this again.\n"
          : "Stopped waiting after 30 minutes. Run this again to keep waiting.\n");
        return 1;
      }
      desk.show();
      const answered = desk.answered;
      if (!away && answered) continue;
      try {
        if (desk.open === null || answered) await wait(POLL_MS, signal);
        else {
          const early = new AbortController();
          const pause = wait(POLL_MS, AbortSignal.any([signal, early.signal]));
          const first = await Promise.race([pause.then(() => "waited" as const), desk.arrived().then(() => "typed" as const)]);
          if (first === "typed") { pause.catch(() => undefined); early.abort(); }
          signal.throwIfAborted();
        }
      } catch (error) {
        if (signal.aborted) { say("Stopped. Run this again to keep waiting.\n"); return 1; }
        throw error;
      }
    }
  } finally {
    if (pending.listing !== null && !await putListing(service, pending.listing)) out("This PC dropped out of your account's list; run link again to list it.\n");
    // the sign-in was only for this: it ends with it, and nothing of it stays on the PC
    await service.signOut().catch(() => out("The sign-in could not be ended at the account service; it ends by itself when it runs out.\n"));
  }
}

export async function link(args: readonly string[], options: LinkOptions): Promise<number> {
  let host: string;
  try { host = new URL(options.origin).host; } catch { host = ""; }
  if (!isLoopbackHost(host)) {
    options.out(`The server at ${options.origin} is not on a loopback address. Run link only on the PC itself, with Ovis listening on 127.0.0.1 (HOST unset).\n`);
    return 1;
  }
  const provider = DEVICE_PROVIDERS.find((name) => args.includes(`--${name}`));
  const api = localApi(options);
  try {
    return args.includes("--code") ? await linkWithCode(options, api) : await linkToAccount(options, api, provider, { approve: args.includes("--approve"), print: args.includes("--print") });
  } catch (error) {
    if (options.signal.aborted) { options.out("Stopped.\n"); return 1; }
    // the account's list refused this PC for want of room (409 directory_full): its code alone says nothing to a person
    const full = error instanceof AccountServiceError && error.code === "directory_full";
    options.out(`Could not link this PC: ${full ? `Your account holds as many PCs as it can. Remove one in the Ovis app, then run ${cli(options)} add again.` : error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
