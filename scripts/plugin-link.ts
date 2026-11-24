/**
 * `link`: a PC with no screen of its own joins the relay from its terminal (docs/relay.md, "A PC
 * with no screen"). Both ways are the ones its own Settings page offers, through the same routes:
 *
 * - `link` (also `add` and `login`, scripts/plugin-runtime.ts COMMAND_ALIASES): sign in to the account with a device code (as a PC's own page does,
 *   src/lib/account/deviceSignIn.ts): the Ovis link page's where the service has it, else, or with
 *   `--github` / `--google`, the provider's own device flow. Then list this PC in the account (src/lib/account/addThisPc.ts),
 *   once the person here confirmed the account that signed in (typed yes at its name, or named it with `--account`, the
 *   only way without a terminal: whoever signs in with the code picks the account), and wait until a device signed in to
 *   it presses Add on this PC's card: that is the account's one-press admission, which this PC takes with its own key's
 *   proof (`addByPress`). At a terminal it then lets in the first device that opens this PC, which nobody else may,
 *   once the six digits that device shows are typed (`watchFirstJoins`).
 * - `link --qr` (or `--print`), and `link` on a PC that takes no such admission: the same sign-in, then
 *   one QR code: a device signed in to that account that scans it puts this PC in the account, with nothing
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
import { hostname } from "node:os";

import qrcode from "qrcode-generator";

import { isLoopbackHost } from "../server/access.ts";
import { fleetPreview } from "../server/preview.ts";
import { accountOsOfPlatform, type AccountOs } from "../shared/account-asker.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../shared/web-policy.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { startDeviceSignIn, startLinkPageSignIn } from "../src/lib/account/deviceSignIn.ts";
import { NEW_PC_MS } from "../src/lib/account/myPcs.ts";
import { ownPcProof } from "../src/lib/account/pcProof.ts";
import { AccountService, AccountServiceError, DEVICE_PROVIDERS, offeredProviders, type DeviceProvider, type DirectoryPc } from "../src/lib/account/service.ts";
import { memoryAccountStore, memoryLock, type AccountProvider } from "../src/lib/account/store.ts";
import { shortAccount } from "./plugin-cli.ts";

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
  /** discards what the terminal holds unread (`AnswerInput.discard`); the command passes `discardTyped` (scripts/libc.ts) */
  readonly discard?: () => boolean;
  /**
   * `out` is a terminal: the only place the QR code that adds this PC is drawn without `--print`, since whoever reads
   * it can pair with this PC. Unset counts as not one.
   */
  readonly isTty?: boolean;
  readonly size?: () => { readonly rows: number; readonly columns: number } | null;
  /** opens the sign-in page in this desktop's browser and says whether it could; unset where there is none (`--no-browser`, SSH) */
  readonly openBrowser?: (url: string) => boolean;
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
/**
 * How long `add` waits for Add: a device of the account offers it for ten minutes from when the PC was listed
 * (src/components/UnconfirmedPcNotices.tsx ADD_WINDOW_MS), and the account's admission lasts as long.
 */
const PRESS_MS = 10 * 60_000;
/**
 * How often `add` asks this PC whether the account admitted it. Each ask has this PC prove itself to the account
 * service, which takes only so many such proofs a minute from one PC, and the PC's own calls need some of them.
 */
const PRESS_POLL_MS = 6_000;
/** How long `add` waits after the account service did not answer this PC, before it asks again. */
const PRESS_BACKOFF_MS = 15_000;
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

export class LocalError extends Error {
  /** `reason`: what is shown to a person, without the route `message` starts with (localApi) */
  constructor(message: string, readonly status = 0, readonly code = "", readonly reason = message) { super(message); }
}

export class AwayError extends Error {}

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

export function localApi(options: LinkOptions) {
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

export type Api = ReturnType<typeof localApi>;

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
export async function relayOn(options: LinkOptions, api: Api): Promise<{ phase: string; blocked: string | null }> {
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

/** What `ovis approve` says when its input is no terminal: it answers nothing, and declines nothing either. */
const NOT_A_TERMINAL = "This is not run in a terminal, so no request can be answered here. Nothing was declined: the requests keep waiting. Run this in a terminal to answer them (over ssh, run ssh -t).\n";

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
    out(NOT_A_TERMINAL);
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

/** What a locked or strict PC says to its terminal (server/lock-boundary.ts): nothing is approved here then. */
export function lockRefusal(code: "locked" | "strict"): string {
  return code === "locked"
    ? "This PC is locked, so no device can be approved from its terminal. Unlock it on its own screen, then run this again.\n"
    : "This PC cannot read its safety log, so no device can be approved from its terminal. Open it on its own screen, or run ovis recover there, then run this again.\n";
}

/**
 * An account join waiting on this PC's own window (`GET /api/relay/joins`). A members join comes without its digits.
 * A first join (`digits`: asked while this PC had no member to approve it, as a PC added in one press has) comes with
 * them, for the own window's card to show; this terminal never shows them, and asks for them typed all the same.
 */
/** `list`: the join is let in by the account's signed list, so an approval is only received here: the device is in once its entry is in the list. */
export interface OwnJoin { readonly id: string; readonly label: string; readonly asked_at?: string; readonly digits?: string; readonly list?: boolean; readonly list_behind?: boolean; readonly list_not_signer?: boolean }

/**
 * What a terminal says once this PC took the approval of `label`: it is let in at once, or, by the account's list, once
 * its entry is there. `cannot`: why this PC signs nobody into its list (`behind`, or `not_signer` for a PC that joined
 * by an invite), so the approval here lets nobody in.
 */
const approvedWords = (label: string, list: boolean, cannot: "behind" | "not_signer" | null = null): string => cannot === "behind"
  ? `${label} was not let in: Ovis on this PC is older than what a device wrote into your account's list, and lets nobody new in until it is updated. Update Ovis on this PC (Settings → Updates), then have ${label} ask again; or allow it on another device of your account.\n`
  : cannot === "not_signer"
  ? `${label} was not let in: this PC joined your account by an invite, and a PC that did lets nobody into your account's list itself. Allow ${label} on another device of your account.\n`
  : list
  ? `The approval of ${label} was received. It opens this PC once it is in your account's list, which takes a moment; if it does not, have it ask again.\n`
  : `${label} is let in; it opens this PC in a moment.\n`;

/** Why this PC signs nobody into its list, as GET /api/relay/joins says of a join into it; null when it may. */
const cannotSign = (join: OwnJoin): "behind" | "not_signer" | null => join.list_behind === true ? "behind" : join.list_not_signer === true ? "not_signer" : null;

/** What `POST /api/relay/join` made of the six digits typed: `away` when its answer did not come. */
export type JoinOutcome = "approved" | "wrong_digits" | "gone" | "locked" | "strict" | "away";

export interface JoinOptions extends AnswerInput {
  readonly approve: (id: string, digits: string) => Promise<JoinOutcome>;
  /** this PC's account, which a first join's admission came from (GET /api/account/status); null or unset when not known */
  readonly account?: string | null;
  /** how this command is typed here, for a run at a terminal */
  readonly command?: string;
}

const clockTime = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** How a first join is named at this terminal: its device, the account its admission came from, and when it asked. */
function firstJoinLead(join: OwnJoin, account: string | null | undefined): string {
  const asked = join.asked_at === undefined ? Number.NaN : Date.parse(join.asked_at);
  const about = [...typeof account === "string" ? [`from Ovis account ${shortAccount(account)}`] : [], ...Number.isFinite(asked) ? [`asked at ${clockTime(asked)}`] : []];
  return `${plainLabel(join.label)} asks to open this PC${about.length === 0 ? "" : ` (${about.join(", ")})`}.`;
}

/**
 * `ovis approve` for the account joins this PC's own window lists: the PC's terminal is the PC itself, so it asks as
 * that window does (src/components/OwnJoins.tsx OwnJoinCard). A join a member could also approve (#28) and a first
 * join, which nobody but this PC may let in (docs/account.md, "Who may admit a device"), are both let in only by all six
 * digits the new device shows, typed here: none are shown, three are not enough. The PC compares them
 * (pairing-approvals.ts decideTyped), and one wrong entry ends that join; the device may ask again. Enter by itself
 * leaves it waiting until its own deadline. A locked or strict PC refuses, and nothing more is asked. What is not a
 * terminal answers nothing, and names each first join with the way to let it in. The exit code.
 */
export async function approveJoins(joins: readonly OwnJoin[], options: JoinOptions): Promise<number> {
  const { out } = options;
  const command = options.command ?? "ovis approve";
  if (options.terminal !== true) {
    for (const join of joins) {
      if (join.digits !== undefined) out(`${firstJoinLead(join, options.account)} Run ${command} in a terminal on this PC and type the six digits ${plainLabel(join.label)} shows.\n`);
    }
    out(NOT_A_TERMINAL);
    return 1;
  }
  for (const join of joins) {
    const label = plainLabel(join.label);
    const first = join.digits !== undefined;
    const prompt = first ? `${firstJoinLead(join, options.account)} Type the six digits ${label} shows (one wrong entry ends this request), or press Enter to skip: `
      : `${label} asks to join your account. Type all six digits its screen shows to let it in (one wrong entry ends this request), or press Enter by itself to leave it waiting: `;
    for (;;) {
      const line = await askLine(options, prompt);
      if (line === null) { out("The terminal's input ended: nothing more is approved here.\n"); return 1; }
      const typed = line.normalize("NFKC").replace(/\s/g, "");
      if (typed === "") { out(`${label} is left waiting until its time runs out.\n`); break; }
      if (!SIX_DIGITS.test(typed)) { out(`That line answered nothing: only all six digits ${label} shows let it in. Answer again.\n`); continue; }
      const outcome = await options.approve(join.id, typed);
      if (outcome === "locked" || outcome === "strict") { out(lockRefusal(outcome)); return 1; }
      if (outcome === "away") { out("Your answer may not have reached the Ovis on this PC. Run this again once it answers.\n"); return 1; }
      // a join into the account's list is let in by its entry, first join or not: the approval was received, no more
      out(outcome === "approved" ? first || join.list === true ? approvedWords(label, join.list === true, cannotSign(join)) : `Approved: ${label} joins your account once it confirms.\n`
        : outcome === "wrong_digits" ? first ? `That is not the number ${label} shows, so it was not let in. To try again, have ${label} ask again, then run ${command} again.\n`
          : `That is not the number ${label} shows. It was not let in; it can ask again.\n`
        : `${label} is no longer waiting.\n`);
      break;
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

export function cli(options: LinkOptions): string {
  return (options.preview === true && options.cliName) || "ovis";
}

/**
 * One line typed at the terminal in answer to `prompt`; null when none can come (the input ended). What was typed
 * before the prompt is discarded as it shows, and a line that comes too soon after it to have been read (DWELL_MS: one
 * typed ahead where the input cannot be discarded, or a key pressed twice) answers nothing, and the prompt is shown
 * again. For a run that reads nothing else meanwhile: it reads one line at a time, and leaves no read open.
 */
export async function askLine(options: AnswerInput, prompt: string): Promise<string | null> {
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

/** `os`: the system this PC runs, which the card of a listing that asks to join shows the account's devices */
export interface Listing { readonly serverId: string; readonly entry: { label: string; public_key: string; relay: string; os?: AccountOs } }

/**
 * Lists this PC in the account with its relay key, which opens the approve-here window (addThisPc.ts
 * listThisPc). An entry about to stop showing as new is listed anew: the service keeps `added_at`
 * over a PUT, so only a DELETE then a PUT shows the card again. The entry is `unlisted.listing` from
 * before that DELETE (whose answer can be lost after the service applied it) until the PUT lands: the
 * caller lists it again until it is back, so a renewal never leaves the PC unlisted.
 * A device code's sign-in may end only a pending listing it wrote itself (account#63), and a refresh takes only a
 * confirmed PC: a listing an earlier run wrote is kept as it is, by a PUT, and `unlisted.kept` says so from then on.
 */
async function listThisPc(api: Api, service: AccountService, now: () => number, unlisted: { listing: Listing | null; kept: boolean }, opened?: Listing): Promise<Listing> {
  const listing = opened ?? await openedListing(api);
  const listed = (await service.listPcs()).find((pc) => pc.server_id === listing.serverId);
  if (listed === undefined || unlisted.kept || now() - Date.parse(listed.added_at) < NEW_PC_MS - RELIST_MS) {
    await service.putPc(listing.serverId, { ...listing.entry, ...await ownPcProof(listing.serverId, (path) => api("POST", path)) });
    unlisted.listing = null;
    await nameRelayAccount(api, service);
    return listing;
  }
  unlisted.listing = listing;
  try { await service.deletePc(listing.serverId); } catch (error) {
    if (!(error instanceof AccountServiceError && error.status === 403 && error.code === "own_sign_in_required")) throw error;
    unlisted.kept = true;
  }
  if (await putListing(api, service, listing)) unlisted.listing = null;
  await nameRelayAccount(api, service);
  return listing;
}

export async function openedListing(api: Api): Promise<Listing> {
  const { url } = await api<{ url: string }>("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
  const offer = decodeOffer(url);
  if (offer === null) throw new LocalError("This PC's pairing link did not parse.");
  const label = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const os = accountOsOfPlatform(process.platform);
  return { serverId: offer.server_id, entry: { label, public_key: publicKey, relay: offer.relay, ...(os === null ? {} : { os }) } };
}

/**
 * Tells this PC the account it is listed under, which its relay pass is asked under (docs/relay.md,
 * "Relay pass"). An Ovis from before relay passes has no such route; this runs again with every relist.
 */
async function nameRelayAccount(api: Api, service: AccountService): Promise<void> {
  const session = await service.session();
  if (session) await api("POST", "/api/account/relay-account", { body: { account: session.account } }).catch(() => undefined);
}

/** Lists this PC with its own proof (ownPcProof), which alone lists it again after `ovis logout` left the account. */
async function putListing(api: Api, service: AccountService, listing: Listing): Promise<boolean> {
  try { await service.putPc(listing.serverId, { ...listing.entry, ...await ownPcProof(listing.serverId, (path) => api("POST", path)) }); return true; } catch { return false; }
}


interface Device {
  readonly id: string; readonly label: string; readonly created_at: string; readonly via_relay?: true; readonly account?: string;
  /** on a member another member brought in: that member's id. A member without it linked itself */
  readonly added_by?: string;
  /** let in by the list of the account this PC is in, never by a code: that account vouches for it */
  readonly through_account?: true;
  /** on a row `through_account`: the day it last signed in here (null before its first sign-in) */
  readonly last_seen_at?: string | null;
  /** to this PC's own window: while one of its sessions is up, and since when */
  readonly connection?: { readonly since: string };
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
  // the devices a code may have let in: one the account's own list let in came by no code, and that account vouches for it
  const devices = async (within?: AbortSignal): Promise<Device[]> => (await api<{ devices: Device[] }>("GET", "/api/devices", within === undefined ? {} : { signal: within })).devices
    .filter((device) => !device.through_account);
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
    const head = ["2/2  Let this PC in", "", "Scan this QR code with a device that is signed in to this Ovis account. It adds this PC to the account; there is no number to type.", ...!tied && !joining.plain ? [OLDER_PC] : [], ""];
    const tail = [
      ...card.typed !== null
        ? [`Code to type: ${card.typed}   (works once, expires in ${left})`, `Or, on that device, open ${appHost(options, card.url)}, choose Pair with a code and type it.`]
        : [`No code to type this time (${card.refused}). The QR code expires in ${left}.`],
      `No device in the account yet? Open ${appHost(options, card.url)} on your phone, sign in, then scan.`,
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
    : new LocalError(`The Ovis on this PC did not take the id of the account you signed in to (${shortAccount(joining.signedIn)}) for its code (${error.message})`, error.status, error.code);
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
        throw new LocalError(`The Ovis on this PC made its code for another Ovis account (${shortAccount(answer.expect_account)}) than the one you signed in to (${shortAccount(joining.signedIn)}). Run ${cli(options)} add again.`);
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
          const said = `This PC joined another Ovis account (${shortAccount(account)})${label === null ? "" : `, added by ${label}`}, not the one you signed in to (${shortAccount(joining.signedIn)}).${removals(outcomes, false)}`;
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
          say(`This PC is in your account (${shortAccount(joining.signedIn)})${label === null ? "" : `, added by ${label}`}: every device of your account can use it.\n${loginClosing(options)}`);
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

/**
 * Whether this PC takes the account's admission from this terminal (POST /api/account/one-press): asked with no
 * account, which it refuses as `invalid_account` before it asks the account service anything. `not-own`: it does not
 * count this terminal as the PC itself (`owner_only`: a forwarded port, say). `off`: anything else (its Step 2 off, an
 * Ovis from before the route).
 */
export async function takesPress(api: Api): Promise<"press" | "off" | "not-own"> {
  try {
    await api("POST", "/api/account/one-press", { body: {} });
    return "off";
  } catch (error) {
    if (!(error instanceof LocalError)) throw error;
    return error.status === 400 && error.code === "invalid_account" ? "press" : error.code === "owner_only" ? "not-own" : "off";
  }
}

/**
 * What became of this PC's listing as a run without its add ends: taken off by this run; `gone`, a device of the
 * account removed it (No); `kept`, still listed, as this sign-in may remove only a listing it made and nobody admitted
 * (a device pressed Add just now, or an earlier run listed it); `failed`, not known.
 */
export type Unlisted = "removed" | "gone" | "kept" | "failed";

export interface Pressing {
  readonly signedIn: string;
  readonly name: string;
  /** when an earlier run listed this PC, which the account's devices offer Add for from then on; null for this run's listing */
  readonly listedAt: number | null;
  /** the account listed this PC as its own before this run (a device pressed Add before): no device offers Add for it any more */
  readonly confirmed: boolean;
  readonly unlist: () => Promise<Unlisted>;
  /**
   * Lists this PC in the account again after its relay identity was reset, as the new PC it is by then: what the
   * re-add of a PC its account's list removed takes. Unset where the run cannot list (`ovis join`): it offers no re-add.
   */
  readonly relist?: () => Promise<void>;
  /**
   * One ask in place of the one for the account's admission: how a run that joins by the account's signed list itself
   * (`ovis join` with an invite's line that names the list) asks this PC whether it is in. `added`, `none`, `slow`,
   * `away` and `joined` as the admission's ask answers them; it throws a LocalError where this PC will not be added.
   */
  readonly take?: () => Promise<"added" | "none" | "slow" | "away" | "joined">;
  /**
   * The run compares no number: it takes the account's admission, or nothing (`ovis join` with a line that names no
   * list). An account that keeps a signed list then refuses it, and says so.
   */
  readonly admissionOnly?: true;
  /** names the account that signed in as the one this PC's relay pass is asked under, which asks for the pass again */
  readonly named: () => Promise<void>;
  /** ends the sign-in, which nothing needs once this PC is added, after a listing a renewal took away went back */
  readonly signOut: () => Promise<void>;
  /** how the run names itself and what led to it: `ovis add`'s sign-in when unset (`ovis join` has an invite instead) */
  readonly words?: PressWords;
  /** told how the run ended, before it returns (`ovis join --json`) */
  readonly report?: (end: PressEnd) => void;
  /** when the account's devices stop offering Add for this PC, by the account service's own word (`ovis join`'s card_until) */
  readonly until?: number;
  /** with `confirmed`: how many asks find no admission before the run gives up (1 when unset) */
  readonly noneTries?: number;
  /** at the end of the wait, asks for the admission once more before the listing is taken off: an Add pressed in its last seconds */
  readonly askBeforeUnlist?: true;
  /**
   * Stopped (Ctrl+C), the listing is taken off first, within the ten seconds a stopped run has (plugin.ts stopOnSignals):
   * this PC's account is read with a short bound first, so a PC that just took its admission is not taken off
   */
  readonly stopFast?: true;
}

export interface PressWords {
  /** the command that is run again to finish, as typed */
  readonly command: string;
  /** what to do to start over once nothing is left of this run */
  readonly anew: string;
  /** the account this PC was to join, after "the one" and "the account": "you signed in to" */
  readonly chosen: string;
  /** the lines said as the wait for Add begins, with the time it lasts */
  readonly waiting: (name: string, lasts: string) => string;
  /** the last lines once this PC is added */
  readonly closing: string;
  /** said when no Add is offered for this PC and no admission waits for it */
  readonly noneWaiting: string;
}

/**
 * How a press ended: added (relay online or not); in another account; or not added, with whether the account still
 * lists this PC (null: not known). `late`: the listing was past its ten minutes before the wait began; `none_waiting`: no
 * Add is offered for it and none waited.
 */
export type PressEnd =
  | { readonly kind: "added"; readonly online: boolean }
  | { readonly kind: "elsewhere"; readonly account: string }
  | { readonly kind: "not_added"; readonly why: "late" | "none_waiting" | "timeout" | "stopped" | "failed"; readonly listed: boolean | null };

const listedAfter = (off: Unlisted): boolean | null => off === "kept" ? true : off === "failed" ? null : false;

/**
 * One reader of the terminal for a whole run (`typing`): the questions a run asks one after another share it, so no
 * line is taken by a read an earlier question left open. `ask` names what is asked about from now on.
 */
interface TerminalReader { readonly keys: ReturnType<typeof typing>; ask(under: () => object | null): void }

function terminalReader(options: LinkOptions, now: () => number): TerminalReader {
  let asked: () => object | null = () => null;
  return { keys: typing(options.lines, options.signal, () => asked(), now), ask(under) { asked = under; } };
}

/** Where this PC's add by its account's signed list stands (GET /api/account/list/add, server/account/list-add.ts). */
type ListAddState =
  | { readonly state: "none" | "no_list" | "replaced" }
  | { readonly state: "waiting" | "confirmed" | "added"; readonly run: string }
  | { readonly state: "number"; readonly run: string; readonly digits: string }
  | { readonly state: "ended"; readonly run?: string; readonly why: string };

/** How often `add` asks this PC where its add by the list stands: the number shows, and a typed yes is taken, within this. */
const LIST_ADD_POLL_MS = 2_000;

const spaced = (digits: string): string => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/**
 * `ovis add --confirm <number>`: where nobody can type at the `ovis add` that shows the number (a script, an agent's
 * run), the person who read it on the phone confirms it with a second command that carries it. It confirms only the
 * number this PC shows at that moment, so nobody confirms without having read it.
 */
async function confirmNumber(options: LinkOptions, api: Api, given: string): Promise<number> {
  const digits = given.normalize("NFKC").replace(/\s/g, "");
  if (!SIX_DIGITS.test(digits)) {
    options.out(`--confirm takes the six digits ${cli(options)} add shows on this PC.\n`);
    return 1;
  }
  const none = `The Ovis on this PC shows no number to confirm. Run ${cli(options)} add first.\n`;
  let state: ListAddState;
  try { state = await api<ListAddState>("POST", "/api/account/list/add/confirm", { body: { digits } }); } catch (error) {
    if (!(error instanceof LocalError)) throw error;
    // not the number on this PC's screen: that number is gone with it, and this PC told none
    if (error.code === "wrong_number") {
      options.out(`${spaced(digits)} is not the number this PC shows now, so nothing was confirmed, and that number is no longer shown (a wrong one ends it). Choose Add on the device again, read the new number ${cli(options)} add shows, and confirm that one.\n`);
      return 1;
    }
    if (error.status !== 404 && error.status !== 405) throw error;
    options.out(none);
    return 1;
  }
  if (state.state === "confirmed" || state.state === "added") {
    options.out(state.state === "added" ? "Confirmed: this PC is in your account.\n"
      : `Confirmed: this PC and that device show ${spaced(digits)}. Press Add for this PC on that device now; the ${cli(options)} add that showed the number finishes when it is added.\n`);
    return 0;
  }
  options.out(state.state === "ended" ? `The add this PC was running has ended (${state.why}), so nothing was confirmed. Run ${cli(options)} add again.\n` : none);
  return 1;
}

/** How long `add` waits, once this PC is added, for the first device that opens it to ask for its six digits. */
const FIRST_JOIN_MS = 10 * 60_000;

/**
 * The end of `add` at a terminal, once this PC is in the account. A PC added in one press has no member yet, so the
 * first device that opens it sends a first join, which nobody but this PC may let in (docs/account.md, "Who may admit
 * a device"), and a PC with no screen has no window to do that in: its terminal stands in, as `ovis approve` does.
 * For up to ten minutes it reads this PC's waiting joins (GET /api/relay/joins), asks about each first join by its
 * device, the account and when it asked, and lets it in once the six digits that device shows are typed here (POST
 * /api/relay/join, which compares them and ends that join at one wrong entry; the device may ask again). It never shows
 * the digits. A line answers only the question it was typed under, and only once that was on the screen long enough to
 * read (DWELL_MS); what the terminal held as a question first showed is discarded, as `asking` does. Enter by itself,
 * the input ending, Ctrl+C and the ten minutes end it, as does a device that got in through the account meanwhile (a
 * member or a row of the account's list that GET /api/devices did not show before, or such a row it showed that signs
 * in during the wait); each end says how to let a device in later. False, with nothing shown, where
 * this PC lists no joins to its terminal (an Ovis from before the route), or the run stopped before the first question.
 */
async function watchFirstJoins(options: LinkOptions, api: Api, watched: { readonly name: string; readonly account: string; readonly hint: string }, reader?: TerminalReader): Promise<boolean> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const { name, account, hint } = watched;
  const joins = async (): Promise<OwnJoin[]> => (await api<{ joins: OwnJoin[] }>("GET", "/api/relay/joins")).joins;
  // the devices that open this PC through its account; null when that could not be read just now
  const throughAccount = async (): Promise<Device[] | null> => {
    try { return (await api<{ devices: Device[] }>("GET", "/api/devices")).devices.filter((device) => device.account !== undefined || device.through_account === true); }
    catch (error) { if (signal.aborted) throw error; return null; }
  };
  try {
    await joins();
  } catch (error) {
    if (signal.aborted || error instanceof LocalError && (error.status === 404 || error.status === 405)) return false;
    if (!(error instanceof LocalError || error instanceof AwayError)) throw error;
  }
  // The devices that could open it already, and how far each was used: one that comes after them got in by itself, and
  // so did a row of the account's list that signs in after them. One press reads the account's list before it answers,
  // so the phone that pressed Add is usually such a row already, and it signs in with no join. GET /api/devices tells
  // that by the day it last signed in (`last_seen_at`, null before its first) and, to this PC's own window, by a session
  // that is up (`connection.since`). Taken at the next look when this read was not answered
  interface Usage { readonly seen: string | null; readonly since: string | null }
  const usage = (device: Device): Usage => ({ seen: device.last_seen_at ?? null, since: device.connection?.since ?? null });
  // a session that ended, or a day that went back, is no sign-in
  const signedIn = (before: Usage, device: Device): boolean => device.through_account === true
    && ((device.last_seen_at ?? null) !== null && device.last_seen_at !== before.seen || (device.connection?.since ?? null) !== null && device.connection?.since !== before.since);
  let known: ReadonlyMap<string, Usage> | null;
  try {
    const rows = await throughAccount();
    known = rows === null ? null : new Map(rows.map((device) => [device.id, usage(device)]));
  } catch { return false; }
  const stopAt = now() + FIRST_JOIN_MS;
  interface Question { readonly prompt: string; shownAt: number | null }
  const intro: Question = { prompt: `Open ${name} from My PCs on your phone. If the phone shows six digits, type them here (Enter to finish without): `, shownAt: null };
  let asked: (Question & { readonly id: string; readonly label: string; readonly list: boolean; readonly cannot: "behind" | "not_signer" | null }) | null = null;
  const current = (): Question => asked ?? intro;
  const seen = new Set<string>();
  let onScreen: Question | null = null;
  let atPrompt = false;
  // why the next line handed over answers nothing, whatever it says: it may have been begun under a question that is gone
  let held: string | null = null;
  let away = false;
  const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
  const show = (): void => {
    const question = current();
    if (atPrompt && onScreen === question) return;
    if (question.shownAt === null) {
      // what was typed before this question and not sent would come with the Enter pressed at it
      let emptied = false;
      try { emptied = options.discard?.() === true; } catch {}
      if (!emptied) held ??= "this terminal's input could not be emptied as the question showed, so it may have been typed before it.";
      question.shownAt = now();
    }
    say(question.prompt);
    atPrompt = true;
    onScreen = question;
  };
  show();
  // the run's one reader of the terminal, when it asked about a number before: what came under that is not for this
  reader?.ask(current);
  reader?.keys.take();
  const keys = reader?.keys ?? typing(options.lines, signal, current, now);
  try {
    for (;;) {
      for (const line of keys.take()) {
        atPrompt = false;
        const question = current();
        if (held !== null) { say(`That line answered nothing: ${held} Answer again.\n`); held = null; continue; }
        if (line.under !== question) { say("That line answered nothing: it was typed before the question shown now. Answer again.\n"); continue; }
        if (question.shownAt === null || line.at - question.shownAt < DWELL_MS) {
          say("That line answered nothing: it came before the question could be read. Answer again.\n");
          question.shownAt = now();
          continue;
        }
        const typed = line.text.normalize("NFKC").replace(/\s/g, "");
        if (typed === "") { say(`Finished without letting a device in. ${hint}`); return true; }
        if (asked === null) { say(`That line answered nothing: no device is asking to open this PC yet. Open ${name} from My PCs on your phone; what it asks shows here.\n`); continue; }
        const { id, label } = asked;
        if (!SIX_DIGITS.test(typed)) { say(`That line answered nothing: type all six digits ${label} shows, or press Enter by itself to finish without. Answer again.\n`); continue; }
        try {
          await api("POST", "/api/relay/join", { body: { id, digits: typed } });
          say(approvedWords(label, asked.list, asked.cannot));
          return true;
        } catch (error) {
          if (signal.aborted || !(error instanceof LocalError || error instanceof AwayError)) throw error;
          asked = null;
          if (error instanceof AwayError) {
            // asked about again while it still waits, never answered by itself, nor by a line typed meanwhile
            seen.delete(id);
            held = "the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile.";
            say(`Your answer may not have reached the Ovis on this PC. ${label} is asked about again if it is still waiting.\n`);
          } else if (error.code === "locked" || error.code === "strict") {
            say(`${lockRefusal(error.code)}${hint}`);
            return true;
          } else {
            say(error.code === "wrong_digits" ? `That is not the number ${label} shows, so it was not let in. Have ${label} ask again: its request shows here.\n`
              : error.code === "relay_pairing_gone" ? `${label} is no longer waiting.\n` : `Could not let ${label} in: ${error.reason}\n`);
          }
        }
      }
      if (signal.aborted) break;
      if (keys.ended) { say(`The terminal's input ended. ${hint}`); return true; }
      try {
        const waiting = (await joins()).filter((join) => join.digits !== undefined);
        if (away) { away = false; say("The Ovis on this PC answers again.\n"); }
        if (asked !== null && !waiting.some((join) => join.id === asked!.id)) {
          say(`${asked.label} is no longer waiting.\n`);
          if (asked.shownAt !== null) held = "a request went away while it may have been typed.";
          asked = null;
        }
        const next: OwnJoin | undefined = asked === null ? waiting.find((join) => !seen.has(join.id)) : undefined;
        if (next !== undefined) {
          seen.add(next.id);
          const label = plainLabel(next.label);
          asked = { id: next.id, label, list: next.list === true, cannot: cannotSign(next), prompt: `${firstJoinLead(next, account)} Type the six digits ${label} shows (one wrong entry ends this request), or press Enter to finish without: `, shownAt: null };
        }
        const rows = await throughAccount();
        if (rows !== null && known === null) known = new Map(rows.map((row) => [row.id, usage(row)]));
        // the device named may not be the phone in hand: the way to let that one in is said too
        const came = rows?.find((row) => { const before = known!.get(row.id); return before === undefined || signedIn(before, row); });
        if (came !== undefined) { say(`${plainLabel(came.label)} can open this PC now: it got in through your account. ${hint}`); return true; }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof AwayError) {
          if (!away) say("The Ovis on this PC is not answering (is it restarting?). Waiting for it…\n");
          away = true;
        } else if (error instanceof LocalError) {
          say(`${error.code === "locked" || error.code === "strict" ? lockRefusal(error.code) : `Could not read which devices ask to open this PC: ${error.reason}\n`}${hint}`);
          return true;
        } else throw error;
      }
      if (now() >= stopAt) { say(`Stopped watching after 10 minutes. ${hint}`); return true; }
      show();
      const early = new AbortController();
      const pause = wait(Math.min(POLL_MS, Math.max(0, stopAt - now())), AbortSignal.any([signal, early.signal]));
      const first = await Promise.race([pause.then(() => "waited" as const), keys.arrived().then(() => "typed" as const)]);
      if (first === "typed") { pause.catch(() => undefined); early.abort(); }
    }
  } catch (error) {
    // the PC is added whatever went wrong here: that is not to be told as a failed add
    if (!signal.aborted) { say(`Stopped waiting for a device: ${error instanceof Error ? error.message : String(error)}. ${hint}`); return true; }
  }
  say(`Stopped. ${hint}`);
  return true;
}

/**
 * The end of `add`, once the person at this PC confirmed the account that signed in (or named it with --account): a
 * device signed in to that account presses Add on this PC's card ("Add this PC to your account?",
 * src/components/UnconfirmedPcNotices.tsx), which is the account's one-press admission of it. This PC takes that
 * admission with its own key's proof (POST /api/account/one-press, server/account/one-press.ts), asked every few seconds
 * until it has it, for as long as the card offers Add. Then its relay comes online. A run that ends otherwise (Ctrl+C,
 * the ten minutes, an error) first reads which account this PC is in: one in the account that signed in is said to be,
 * one in another account is reported, and for one in none the command tries to take its listing off that account's
 * list, which this sign-in may do only for a listing it made and nobody admitted, and says what is left.
 */
export async function addByPress(options: LinkOptions, api: Api, press: Pressing): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const name = plainLabel(press.name);
  const words = press.words ?? addWords(options);
  const { command, anew, chosen } = words;
  const ended = (end: PressEnd, code: number): number => { press.report?.(end); return code; };
  const mine = shortAccount(press.signedIn);
  const startedAt = now();
  const stopAt = press.until ?? Math.min(startedAt + PRESS_MS, press.listedAt === null ? Infinity : press.listedAt + PRESS_MS);
  if (stopAt <= startedAt) {
    out(`An earlier ${command} listed this PC in your account at ${clockTime(press.listedAt!)}, more than 10 minutes ago, so your devices no longer offer Add for it. On a device of your account, choose No or Remove from my account on its card, then run ${command} again.\n`);
    return ended({ kind: "not_added", why: "late", listed: true }, 1);
  }
  // a terminal that went away takes no write: what is owed to this PC (its listing) comes first, then a word that may fail
  const tell = (text: string): void => { try { out(text); } catch {} };
  // `none`: this PC said it is in no account; otherwise that was not known
  const left = (off: Unlisted, finish: string, none: boolean): string => {
    const where = none ? "; it is in no account" : "";
    const said = {
      removed: `This PC was taken off your account's list${where}. ${anew}`,
      gone: `Your account no longer lists this PC (a device chose No)${where}. ${anew}`,
      kept: `${none ? "This PC is in no account yet, but your account still lists it." : "Your account still lists this PC."} ${finish}`,
      failed: `This PC${none ? " is in no account, but it" : ""} could not be taken off your account's list just now: choose No on its card on a device of your account, or run ${command} again.`,
    }[off];
    return none ? said : `${said} The Ovis on this PC did not say whether it is in an account: ${cli(options)} status says.`;
  };
  // the account this PC is in, read on a signal of its own (Ctrl+C aborted the run's): null for none, undefined when it did not answer
  const where = async (ms = 5_000): Promise<string | null | undefined> => {
    try { return (await api<{ account: string | null }>("GET", "/api/account/status", { signal: AbortSignal.timeout(ms) })).account; }
    catch { return undefined; }
  };
  // this PC took the admission: from here on it is in the account, whatever stops the run
  let bound = false;
  // An account that keeps a signed list takes this PC by that list alone (docs/account.md, "A PC is added to the
  // list"): the device that adds it and this PC show one number, the person here says they are the same, and only
  // then does Add on that device add it. null: not asked yet; false: the account keeps none, or this Ovis has no such route
  let byList = (press.admissionOnly === true ? false : null) as boolean | null;
  // this PC knows of no add (it restarted): the add is started again
  let restart = false;
  let listOver = false;
  // the add this run started on this PC: its polls, its yes and its cancel name it, so another run's add is never taken for it
  let runId: string | null = null;
  const dropRun = async (): Promise<void> => {
    if (runId === null) return;
    const id = runId;
    runId = null;
    await api("POST", "/api/account/list/add/cancel", { body: { run: id }, signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
  };
  let reader: TerminalReader | null = null;
  const canType = options.terminal === true && options.isTty === true;
  let question: { readonly digits: string; readonly prompt: string; shownAt: number | null } | null = null;
  let onScreen: object | null = null;
  let atPrompt = false;
  let heldLine: string | null = null;
  let printed: string | null = null;
  let confirmedSaid = false;
  const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
  const ask = (): void => {
    if (question === null || (atPrompt && onScreen === question)) return;
    if (question.shownAt === null) {
      // what was typed before this question and not sent would come with the Enter pressed at it
      let emptied = false;
      try { emptied = options.discard?.() === true; } catch {}
      if (!emptied) heldLine ??= "this terminal's input could not be emptied as the question showed, so it may have been typed before it.";
      question.shownAt = now();
    }
    say(question.prompt);
    atPrompt = true;
    onScreen = question;
  };
  // the lines typed since the last look: only one typed under the number on the screen, once it could be read, answers
  const typedLines = async (): Promise<void> => {
    if (reader === null) return;
    for (const line of reader.keys.take()) {
      atPrompt = false;
      if (heldLine !== null) { say(`That line answered nothing: ${heldLine} Answer again.\n`); heldLine = null; continue; }
      if (question === null) { say("That line answered nothing: this PC shows no number just now.\n"); continue; }
      if (line.under !== question) { say("That line answered nothing: it was typed before the number shown now. Answer again.\n"); continue; }
      if (question.shownAt === null || line.at - question.shownAt < DWELL_MS) {
        say("That line answered nothing: it came before the number could be compared. Answer again.\n");
        question.shownAt = now();
        continue;
      }
      const typed = line.text.normalize("NFKC").trim().toLowerCase();
      if (typed !== "" && typed !== "yes" && typed !== "y") { say("That line answered nothing: type yes if that device shows the same number, or press Enter by itself if it does not. Answer again.\n"); continue; }
      const { digits } = question;
      question = null;
      try {
        if (typed === "") { await api("POST", "/api/account/list/add/cancel", { body: runId === null ? {} : { run: runId } }); continue; }
        await api<ListAddState>("POST", "/api/account/list/add/confirm", { body: { digits, ...runId === null ? {} : { run: runId } } });
      } catch (error) {
        if (!signal.aborted && error instanceof LocalError && error.code === "wrong_number") { say("That number is no longer the one this PC shows, so nothing was confirmed.\n"); continue; }
        if (signal.aborted || !(error instanceof AwayError)) throw error;
        heldLine = "the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile.";
        say("Your answer may not have reached the Ovis on this PC. The number is asked about again while it still shows.\n");
      }
    }
  };
  const ENDED: Readonly<Record<string, string>> = {
    cancelled: "the numbers were not the same, so nothing was added. If the device that adds this PC showed another number, something stood between the two: try once more, and if they differ again, do not add it",
    attempts: "this PC showed three numbers in this run and none was confirmed",
    removed: "this PC was removed from this Ovis account, and comes back only as a new PC",
    other_account: "this PC is in another Ovis account",
    unavailable: "this PC's relay identity or its list keys could not be used (its relay identity may have been reset meanwhile)",
  };
  // a PC its account's list removed comes back only as a new PC: its relay identity reset and the add, as one step a
  // person at this PC confirms. Nothing does it by itself
  const addAgain = async (): Promise<void> => {
    if (press.relist === undefined || !canType || reader !== null) {
      throw new LocalError(`This PC was removed from this Ovis account. It can come back only as a new PC, which a person at this PC confirms: run ${cli(options)} add in a terminal on it.`);
    }
    // the relay identity the question is about, read before it is asked: the reset names it, so a yes typed at a
    // question that is no longer true (another terminal answered first, and the PC is a new one by now) resets nothing
    const health = await api<{ web_ui?: { server_id?: unknown } }>("GET", "/api/health");
    const removedAs = health.web_ui?.server_id;
    if (typeof removedAs !== "string") throw new LocalError(`This PC was removed from this Ovis account, and the Ovis on it did not say which PC it is. Update it in Settings → Updates, then run ${cli(options)} add again.`);
    const line = await askLine(options, "This PC was removed from this Ovis account. It can come back only as a new PC: its relay identity is reset, so every device that opens it through the Ovis relay is let in again. Add it again as a new PC? Type yes: ");
    if (line === null || line.normalize("NFKC").trim().toLowerCase() !== "yes") throw new LocalError("This PC was removed from this Ovis account, and was not added again.");
    await press.unlist();
    try { await api("POST", "/api/relay/reset-identity", { body: { removed: { account: press.signedIn, server_id: removedAs } } }); } catch (error) {
      if (error instanceof LocalError && error.code === "in_account") throw new LocalError(`This PC is in an Ovis account now, so nothing was reset. Run ${cli(options)} status to see where it stands.`);
      if (error instanceof LocalError && (error.code === "identity_changed" || error.code === "not_removed")) throw new LocalError(`This PC is no longer the one that question was about (it was reset already), so nothing was reset. Run ${cli(options)} status to see where it stands.`);
      throw error;
    }
    await press.relist();
    out(`${STEP_INDENT}This PC has a new relay identity, and is listed in your account again.\n`);
  };
  // one ask of this PC's add by the list: null where the account keeps no list, so the admission is asked for instead
  const takeByList = async (): Promise<"added" | "none" | "slow" | "away" | "joined" | null> => {
    let state: ListAddState;
    try {
      await typedLines();
      state = byList === true && !restart && runId !== null ? await api<ListAddState>("GET", `/api/account/list/add?run=${runId}`)
        : await api<ListAddState>("POST", "/api/account/list/add", { body: { account: press.signedIn } });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AwayError) return "away";
      if (!(error instanceof LocalError)) throw error;
      // an Ovis from before lists, or one that follows none
      if (byList === null && (error.status === 404 || error.status === 405)) return null;
      if (error.code === "in_account") return "joined";
      if (error.code === "account_unavailable") return "slow";
      if (error.code !== "list_removed") throw error;
      await addAgain();
      return "none";
    }
    // another add took this one's place on this PC (another terminal, the PC's own window): this run says so, and
    // reports nothing that is the other's
    if (state.state === "replaced") { runId = null; throw new LocalError("another add was started on this PC meanwhile, which took this one's place"); }
    restart = state.state === "none";
    if (state.state === "no_list") return null;
    if ("run" in state && state.run !== undefined) runId = state.run;
    if (byList === null && state.state !== "none") {
      byList = true;
      say(`${STEP_INDENT}Your account keeps a signed list of its devices: the device that adds this PC shows a number, and this PC shows it here. They must be the same before you press Add.\n`);
    }
    if (state.state === "added") { question = null; bound = true; return "added"; }
    if (state.state === "ended") {
      question = null;
      if (state.why === "timeout") { listOver = true; return "none"; }
      throw new LocalError(ENDED[state.why] ?? `this PC could not join the account's list (${state.why})`);
    }
    if (state.state === "number") {
      const { digits } = state;
      if (!canType || reader?.keys.ended === true) {
        if (printed !== digits) {
          printed = digits;
          say(`This PC shows ${spaced(digits)}. If the device that adds it shows the same number, run ${cli(options)} add --confirm ${digits} on this PC within 2 minutes, then press Add on that device. If it shows another number, confirm nothing. (An agent adds a PC in one step with an invite: ${cli(options)} join.)\n`);
        }
      } else {
        reader ??= terminalReader(options, now);
        reader.ask(() => question !== null && question.shownAt !== null ? question : null);
        if (question === null || question.digits !== digits) {
          if (question !== null && question.shownAt !== null) heldLine = "the number changed while it may have been typed.";
          question = { digits, prompt: `This PC shows ${spaced(digits)}. Does the device that adds it show the same number? Type yes if it does, or press Enter if it does not: `, shownAt: null };
        }
        ask();
      }
    } else if (question !== null) {
      // the number ran out, or another device asked: what was typed at it answers nothing
      if (question.shownAt !== null) heldLine = "the number went away while it may have been typed.";
      question = null;
      if (state.state === "waiting") say("That number is no longer shown: it lasts 2 minutes. Choose Add on that device again for a new one.\n");
    }
    if (state.state === "confirmed" && !confirmedSaid) {
      confirmedSaid = true;
      say(`Confirmed. Press Add for ${name} on that device now.\n`);
    }
    return "none";
  };
  const added = async (): Promise<number> => {
    if (atPrompt) say("");
    // in the account, which lists it now: its relay pass is asked for again (it was refused while unlisted), and the relay comes online
    await press.named();
    let online = true;
    try { await relayOnline(options, api); } catch (error) {
      if (signal.aborted || !(error instanceof LocalError || error instanceof AwayError)) throw error;
      online = false;
    }
    // what follows reads this PC only: the sign-in ends here, not with the run up to ten minutes later
    await press.signOut();
    // the first device that opens this PC asks for six digits only this PC may let in (a first join): here, at a
    // terminal, they are typed in the same run; elsewhere it is said where to type them
    const hint = `If your phone asks for six digits when you open ${name}, run ${cli(options)} approve on this PC and type them.\n`;
    if (!online) {
      out(`Added: this PC is in your account (${mine}), but its Ovis relay did not come online within 30 seconds. Your devices can open ${name} from My PCs once it does (${cli(options)} status says when).\n${hint}${words.closing}`);
      return ended({ kind: "added", online: false }, 0);
    }
    out("Added. ");
    const watched = options.terminal === true && options.isTty === true && await watchFirstJoins(options, api, { name, account: press.signedIn, hint }, reader ?? undefined);
    out(`${watched ? "" : `Open ${name} from My PCs.\n${hint}`}${words.closing}`);
    return ended({ kind: "added", online: true }, 0);
  };
  // in another account than the one this PC was to join: taken off that one's list, and both named
  const elsewhere = async (account: string): Promise<number> => {
    const off = await press.unlist();
    tell(`This PC joined another Ovis account (${shortAccount(account)}), not the one ${chosen} (${mine}). ${off === "removed" || off === "gone" ? `It is not on the list of the account ${chosen}.` : `It could not be taken off the list of the account ${chosen}; remove it there.`} If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
    return ended({ kind: "elsewhere", account }, 1);
  };
  // one ask: `added` once this PC took the admission, `none` while there is none, `slow` when the account service did
  // not answer this PC, `away` when this PC did not answer, `joined` when this PC is in an account by now
  const take = async (): Promise<"added" | "none" | "slow" | "away" | "joined"> => {
    if (press.take !== undefined) {
      const got = await press.take();
      if (got === "added") bound = true;
      return got;
    }
    if (byList !== false) {
      const got = await takeByList();
      if (got !== null) return got;
      byList = false;
    }
    try {
      await api("POST", "/api/account/one-press", { body: { account: press.signedIn } });
      bound = true;
      return "added";
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AwayError) return "away";
      if (!(error instanceof LocalError)) throw error;
      if (error.code === "no_admission") return "none";
      if (error.code === "account_unavailable") return "slow";
      if (error.code === "in_account") return "joined";
      throw error;
    }
  };
  // in an account by now: the one this PC was to join (an answer of an earlier ask was lost, or a device paired meanwhile), or another
  const joined = async (): Promise<number | null> => {
    const account = await where();
    if (account === null || account === undefined) return null;
    return account === press.signedIn ? await added() : await elsewhere(account);
  };
  let away = false;
  let slow = false;
  let nones = 0;
  // from here on this PC is listed, so a run stopped anywhere below (this first request included) tries to unlist it
  try {
    // the window the listing opened takes digits approved here, which this way does not ask for
    await api("POST", "/api/relay/link/close").catch((error: unknown) => { if (signal.aborted || !(error instanceof LocalError || error instanceof AwayError)) throw error; });
    out(words.waiting(name, remaining(stopAt - startedAt)));
    for (;;) {
      const got = await take();
      if (got === "added") return await added();
      // an Add pressed before this run is taken at once, within its ten minutes; after them nothing offers Add again
      if (got === "none" && press.confirmed && ++nones >= (press.noneTries ?? 1)) {
        // a PC its account bound meanwhile (a join by its list whose copy is not on disk yet still says it waits)
        // keeps its listing and is added: where this PC stands is asked before anything is taken off
        const account = await where();
        if (account === press.signedIn) return await added();
        out(words.noneWaiting);
        return ended({ kind: "not_added", why: "none_waiting", listed: true }, 1);
      }
      if (got === "joined") {
        const end = await joined();
        if (end !== null) return end;
      }
      if (got === "away" && !away) say("The Ovis on this PC is not answering (is it restarting?). Waiting for it…\n");
      if (got !== "away" && away) say("The Ovis on this PC answers again.\n");
      away = got === "away";
      if (got === "slow" && !slow) say("The account service did not answer this PC just now. Still waiting…\n");
      slow = got === "slow";
      if (now() >= stopAt || listOver) break;
      if (byList !== true) { await wait(Math.min(slow ? PRESS_BACKOFF_MS : PRESS_POLL_MS, stopAt - now()), signal); continue; }
      // by the list: this PC is asked more often, and a line typed at the number is taken as it comes
      ask();
      const early = new AbortController();
      const pause = wait(Math.min(LIST_ADD_POLL_MS, stopAt - now()), AbortSignal.any([signal, early.signal]));
      const typed = reader as TerminalReader | null;
      const first = typed === null || typed.keys.ended ? await pause.then(() => "waited" as const) : await Promise.race([pause.then(() => "waited" as const), typed.keys.arrived().then(() => "typed" as const)]);
      if (first === "typed") { pause.catch(() => undefined); early.abort(); }
    }
    if (atPrompt) say("");
    // the time is up. A bind whose answer was lost is found first; then an Add that landed as it ran out keeps the
    // listing from being taken off, and is taken by one more ask
    await dropRun();
    const account = await where();
    if (account === press.signedIn) return await added();
    if (account !== null && account !== undefined) return await elsewhere(account);
    if (press.askBeforeUnlist) {
      const got = await take();
      if (got === "added") return await added();
      if (got === "joined") {
        const end = await joined();
        if (end !== null) return end;
      }
    }
    const off = await press.unlist();
    if (off === "kept") {
      const got = await take();
      if (got === "added") return await added();
      if (got === "joined") {
        const end = await joined();
        if (end !== null) return end;
      }
    }
    tell(`Nobody pressed Add for ${name} within 10 minutes of its listing. ${left(off, `On a device of your account, choose No or Remove from my account on its card, then run ${command} again.`, account === null)}\n`);
    return ended({ kind: "not_added", why: "timeout", listed: listedAfter(off) }, 1);
  } catch (error) {
    // the add this run started is given up with it, whatever ended the run (an error of its own, its terminal gone
    // too): a yes confirmed here joins nothing once the run is gone. A PC already bound keeps what it has
    if (!bound) await dropRun();
    if (!signal.aborted && !(error instanceof LocalError || error instanceof AwayError)) throw error;
    if (atPrompt) { try { say(""); } catch {} }
    if (signal.aborted && press.stopFast) {
      const account = bound ? press.signedIn : await where(1_000);
      if (account === press.signedIn) {
        tell(`Stopped. This PC is in Ovis account ${mine} all the same: your devices can open ${name} from My PCs once its relay is online. If that is not your account, run ${cli(options)} logout now.\n`);
        return ended({ kind: "added", online: false }, 0);
      }
      if (account !== null && account !== undefined) return await elsewhere(account);
      const off = await press.unlist();
      tell(`Stopped. ${left(off, `A device may have pressed Add just now. Run ${command} again to finish adding it.`, account === null)}\n`);
      return ended({ kind: "not_added", why: "stopped", listed: listedAfter(off) }, 1);
    }
    const reason = error instanceof LocalError ? error.reason : error instanceof Error ? error.message : String(error);
    const lead = signal.aborted ? "Stopped." : `Could not add this PC: ${reason.replace(/[.\s]*$/, ".")}`;
    // this PC may have taken the admission meanwhile (a Ctrl+C as an ask answered, or during the relay's wait)
    const account = await where();
    if (account === press.signedIn) {
      tell(`${lead} This PC is in Ovis account ${mine} all the same: your devices can open ${name} from My PCs once its relay is online. If that is not your account, run ${cli(options)} logout now.\n`);
      return ended({ kind: "added", online: false }, 0);
    }
    if (account !== null && account !== undefined) return await elsewhere(account);
    const off = await press.unlist();
    const finish = `Run ${command} again to finish adding it.`;
    tell(`${lead} ${left(off, signal.aborted ? `A device may have pressed Add just now. ${finish}` : finish, account === null)}\n`);
    return ended({ kind: "not_added", why: signal.aborted ? "stopped" : "failed", listed: listedAfter(off) }, 1);
  }
}

/** `ovis add`'s words for the press: a sign-in on this PC chose the account. */
function addWords(options: LinkOptions): PressWords {
  const command = `${cli(options)} add`;
  return {
    command, anew: `Run ${command} to try again.`, chosen: "you signed in to", closing: loginClosing(options),
    waiting: (name, lasts) => [
      ...step([`This PC is listed in your account as ${name}.`]),
      "",
      "2/2  Press Add on a device of your account",
      ...step([`Open Ovis on your phone or another PC and press Add for ${name}.`, `Waiting… (up to ${lasts}, Ctrl+C to stop)`]),
      "",
    ].join("\n"),
    noneWaiting: `Your account lists this PC already, so your devices offer no Add for it, and no Add pressed in the last 10 minutes waits for it. Run ${command} --approve, then choose Add on this PC in Ovis on a device of your account and compare its number here.\n`,
  };
}

/**
 * What `add --account` and `join` say of a PC in another account than the one they were given: it is never moved, and
 * that account is named by its start only, as `ovis status` names it.
 */
export const inAnotherAccount = (options: LinkOptions, account: string, command: string): string =>
  `This PC is in another Ovis account (${shortAccount(account)}). Run ${cli(options)} logout to take it out of that one first, then run ${command} again.`;

/** `--account`'s id names `account`: all of it, or its start as `ovis status` shows it (12 characters at least). */
export const pins = (pinned: string, account: string): boolean => pinned === account || (pinned.length >= 12 && account.startsWith(pinned));

/**
 * The account that signed in, as the person at this PC is asked to confirm it. Its id leads, with where to compare it:
 * whoever signed in with the code chose that account, and the names of its PCs are its own word (a decoy account can
 * carry the owner's PC names), so they follow as what it lists, never as proof.
 */
function accountQuestion(options: LinkOptions, provider: AccountProvider, account: string, pcs: readonly DirectoryPc[]): string[] {
  const listed = pcs.slice(0, 6).map((pc) => `  - ${plainLabel(pc.label)}${Number.isFinite(Date.parse(pc.added_at)) ? ` (added ${pc.added_at.slice(0, 10)})` : ""}`);
  return [
    `Ovis account ${shortAccount(account)} (signed in with ${PROVIDER_NAMES[provider]}).`,
    "Compare this ID with Settings → Manage account → Account ID in your",
    `Ovis app, or with ${cli(options)} status on a PC you already use.`,
    ...pcs.length === 0 ? ["That account lists no PCs yet."]
      : ["That account lists:", ...listed, ...pcs.length > listed.length ? [`  and ${pcs.length - listed.length} more`] : []],
  ];
}

async function linkToAccount(options: LinkOptions, api: Api, forced: DeviceProvider | undefined, mode: { readonly approve: boolean; readonly print: boolean; readonly qr: boolean; readonly account?: string }): Promise<number> {
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
    // a script's --account names the account it means: another one is never reported as done, nor switched to
    if (mode.account !== undefined && !pins(mode.account, first.account)) {
      out(`${inAnotherAccount(options, first.account, `${cli(options)} add`)}\n`);
      return 1;
    }
    if (first.enrolling !== true) {
      out(`This PC is already in an Ovis account (${shortAccount(first.account)}).\n`);
      return 0;
    }
    out(`This PC is already in an Ovis account (${shortAccount(first.account)}), but its account's other devices are not in yet. Open the Ovis app on the phone that added it. Waiting for them; press Ctrl+C to stop.\n`);
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
        out(`This PC is in an Ovis account (${shortAccount(again.account ?? first.account)}): every device of that account can use it.\n`);
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
  // Without --qr (or --print, which is about the QR code), a device of the account adds this PC by pressing Add, and
  // this PC takes that admission itself. One that takes none from here (its Step 2 off, or older) shows the QR code
  const takes = !mode.approve && !mode.qr ? await takesPress(api) : null;
  const press = takes === "press";
  const byQr = !mode.approve && !press;
  const preview = options.preview === true;
  // Whoever signs in with the code this command shows names the account this PC joins, and a code can leak (a
  // scrollback, a shared screen, a transcript). So the person at this PC confirms the account before anything is
  // listed: at a terminal by typing yes, elsewhere only by naming it in advance (--account). Said before the sign-in
  const interactive = options.terminal === true && options.isTty === true;
  if (press && preview && !interactive) {
    out(`Adding this PC needs a terminal: there it asks whether the account that signed in is yours. Run ${cli(options)} add in a terminal (over ssh, run ssh -t).\n`);
    return 1;
  }
  if (press && !interactive && mode.account === undefined) {
    out(`Not run in a terminal, so nobody here can confirm the account that signs in. Run ${cli(options)} add --account <your account id> (${cli(options)} status on a PC already in your account shows the id, and so does Manage account in Settings), or run ${cli(options)} add in a terminal.\n`);
    return 1;
  }
  // said before the sign-in, not after it: the QR code admits whoever reads it, so it goes to a terminal only
  // (under the fleet preview with --print too, and only once Enter was pressed there under the account's name)
  if (preview && byQr && (options.isTty !== true || options.terminal !== true)) {
    out(`Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ${cli(options)} add in a terminal (over ssh, run ssh -t).\n`);
    return 1;
  }
  if (!preview && byQr && !mode.print && options.isTty !== true) {
    out("The QR code is a key to this PC. Run this in a terminal, or pass --print to write it anyway.\n");
    return 1;
  }
  if (byQr && takes !== null) {
    out(takes === "not-own"
      ? "The Ovis on this PC does not count this terminal as the PC itself, so it cannot take an Add pressed on your phone from here: a device of your account adds it by scanning a QR code.\n"
      : "The Ovis on this PC cannot take an Add pressed on your phone (its Step 2 is off, or it is older), so a device of your account adds it by scanning a QR code.\n");
  }
  await relayOn(options, api);
  const store = memoryAccountStore();
  const lock = memoryLock();
  const serviceFetch = options.serviceFetch ?? fetch;
  const offer = forced === undefined ? await offeredProviders(options.accountService, ["github"], { fetch: serviceFetch }) : null;
  const requester = { label: hostname(), os: accountOsOfPlatform(process.platform) };
  const startOptions = { service: options.accountService, store, lock, fetch: serviceFetch, now, wait, requester };
  const signIn = offer !== null && offer.page.length > 0 ? await startLinkPageSignIn(startOptions, offer.device[0] ?? "github") : await startDeviceSignIn({ ...startOptions, provider: forced ?? offer?.device[0] ?? "github" });
  out(signInSteps(signIn, { ...options, label: requester.label, expiresIn: remaining(Math.max(0, signIn.expiresAt - now())) }));
  await signIn.finish(signal);
  const service = new AccountService({ store, lock, fetch: serviceFetch, now });
  const session = await service.session();
  const signedIn = session?.account ?? null;
  const pending: { listing: Listing | null; kept: boolean } = { listing: null, kept: false };
  const unlisted = "This PC could not be listed in your account again just now; it is tried again until it is.\n";
  let ended = false;
  // the sign-in was only for this: it ends with it, and nothing of it stays on the PC. A listing a renewal took away goes back first
  const signOut = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    if (pending.listing !== null && !await putListing(api, service, pending.listing)) out("This PC dropped out of your account's list; run link again to list it.\n");
    await service.signOut().catch(() => out("The sign-in could not be ended at the account service; it ends by itself when it runs out.\n"));
  };
  const kept = "This PC stays listed, but an earlier run listed it, so your other devices may no longer show it as new.\n";
  try {
    if (session === undefined || signedIn === null) throw new LocalError("The sign-in did not last. Run this again.");
    if (mode.account !== undefined && !pins(mode.account, signedIn)) {
      out(`Signed in to Ovis account ${shortAccount(signedIn)}, not the one --account names (${shortAccount(mode.account)}), so this PC was not listed in it. Run ${cli(options)} add again and sign in with that account.\n`);
      return 1;
    }
    // the account's own PCs and the ones it waits to add, read before anything is listed: named in the question, and
    // telling whether an earlier run listed this PC
    const lists = press ? await Promise.all([service.listUnconfirmedPcs(), service.listPcs()]) : null;
    if (lists !== null) {
      if (mode.account === undefined || preview) {
        const asked = step([...accountQuestion(options, session.provider, signedIn, lists[1]), "Is this your account? Type yes to add this PC to it: "]).join("\n");
        const line = await askLine(options, asked);
        if (line === null || line.normalize("NFKC").trim().toLowerCase() !== "yes") {
          out(`This PC was not listed in that account. Run ${cli(options)} add again and sign in with your own account.\n`);
          return 1;
        }
      } else out(`${STEP_INDENT}Ovis account ${shortAccount(signedIn)} (signed in with ${PROVIDER_NAMES[session.provider]}) is the one --account names.\n`);
    }
    if (preview && byQr) {
      // The account as the service's token answer names it: its id and the provider it signed in with (the service
      // keeps no login or email to name it by). It is named before this PC is listed in it or any QR code is shown,
      // and the QR code waits for Enter under that name
      const line = await askLine(options, `Signed in as Ovis account ${signedIn} (signed in with ${PROVIDER_NAMES[session.provider]}). Press Enter to show the QR code for this account's phone, or press Ctrl+C if that is not your account: `);
      if (line === null || line.normalize("NFKC").trim() !== "") {
        out(`The QR code was not shown, and this PC was not listed in that account. Run ${cli(options)} add again and sign in with your own account.\n`);
        return 1;
      }
    }
    const opened = press ? await openedListing(api) : undefined;
    const first = await listThisPc(api, service, now, pending, opened);
    if (pending.kept) out(kept);
    if (pending.listing !== null) out(unlisted);
    // a renewal's listing not put back yet goes back first: an account that does not list the PC gives it no pass
    if (pending.listing !== null && await putListing(api, service, pending.listing)) { pending.listing = null; await nameRelayAccount(api, service); }
    if (lists !== null) {
      // the listing an earlier run left: the account's devices offer Add for ten minutes from its own listing, and none
      // once the account lists the PC as its own (an Add pressed then)
      const at = Date.parse(lists[0].find((pc) => pc.server_id === first.serverId)?.added_at ?? "");
      // the PC as this run lists it: another one once its relay identity was reset (the re-add of a removed PC)
      let listedAs = first;
      return await addByPress(options, api, {
        signedIn, name: first.entry.label, listedAt: Number.isFinite(at) ? at : null,
        confirmed: lists[1].some((pc) => pc.server_id === first.serverId),
        named: () => nameRelayAccount(api, service),
        signOut,
        unlist: async () => {
          try { await service.deletePc(listedAs.serverId); return "removed"; } catch (error) {
            if (!(error instanceof AccountServiceError && error.status === 403 && error.code === "own_sign_in_required")) return "failed";
          }
          try { return [...await service.listUnconfirmedPcs(), ...await service.listPcs()].some((pc) => pc.server_id === listedAs.serverId) ? "kept" : "gone"; }
          catch { return "failed"; }
        },
        relist: async () => {
          await relayOn(options, api);
          listedAs = await listThisPc(api, service, now, pending, await openedListing(api));
          await nameRelayAccount(api, service);
        },
      });
    }
    try { await relayOnline(options, api); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      throw new LocalError(`This PC stays listed in your account, but its Ovis relay is not online yet (${error.message}) Run this again once it is.`);
    }
    const name = first.entry.label;
    if (!mode.approve) {
      out(`${STEP_INDENT}${preview ? `This PC is listed in that account as ${name}.` : `Signed in. This PC is listed in your account as ${name}.`}\n`);
      return await addByQr(options, api, {
        signedIn, status, plain: mode.print || options.isTty !== true,
        unlist: () => { pending.listing = null; return service.deletePc(first.serverId).then(() => true, () => false); },
        name: () => nameRelayAccount(api, service),
        tend: async () => { if (pending.listing !== null && await putListing(api, service, pending.listing)) pending.listing = null; },
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
      `${STEP_INDENT}Signed in. This PC is listed in your account as ${name}.`,
      "",
      "2/2  Approve the device that adds this PC",
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
      say(`This PC joined another Ovis account (${shortAccount(account)}), not the one you signed in to (${shortAccount(signedIn)}). ${unlistedThere ? "It was taken off the list of the account you signed in to." : "It could not be taken off the list of the account you signed in to; remove it there."} If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
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
          say(`This PC is in your account (${shortAccount(joined.account)}): every device of your account can use it.\n${loginClosing(options)}`);
          return 0;
        }
        added = joined.account !== null;
        if (added && !enrollingSaid) {
          enrollingSaid = true;
          say("Added. Bringing in your account's other devices…\n");
        }
        // a listing a renewal took away goes back, also once this PC is in the account: unlisted, it gets no relay pass
        if (pending.listing !== null && now() < stopAt && await putListing(api, service, pending.listing)) pending.listing = null;
        if (!added && now() < stopAt) {
          const last = lastLooks();
          let opened = false;
          if ((now() - listedAt >= RELIST_MS || (last && !lastListed)) && mayOpen()) {
            // a renewal that failed after its DELETE went out keeps waiting: the listing is put back above, as after a failed PUT.
            // None in the last ten minutes: it would show the PC as new for ten more, past the window's end
            const keptBefore = pending.kept;
            try { await listThisPc(api, service, now, pending); } catch (error) {
              if (pending.listing === null) throw error;
            }
            if (pending.kept && !keptBefore) say(kept);
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
    await signOut();
  }
}

export const STEP_INDENT = "     ";
export const step = (lines: readonly string[]): string[] => lines.map((line) => line === "" ? "" : STEP_INDENT + line);

/**
 * Step 1 of `ovis login`, laid out as `codex login` is: on a desktop the sign-in page opens by itself, with the code
 * filled in where the service gives one, and the address stays on screen for another device; anywhere else (SSH,
 * --no-browser, no desktop) the address and the code to type are the screen, with a QR code of the filled-in page.
 */
function signInSteps(
  signIn: { readonly provider: string; readonly verificationUri: string; readonly verificationUriComplete: string | null; readonly userCode: string },
  options: LinkOptions & { readonly label: string; readonly expiresIn: string },
): string {
  const page = signIn.verificationUriComplete ?? signIn.verificationUri;
  // a test copy of the service may ask for another sign-in there
  const there = signIn.provider !== "ovis" ? `Sign in with ${signIn.provider === "github" ? "GitHub" : "Google"} there.`
    : options.accountService === DEFAULT_ACCOUNT_SERVICE ? "Then continue with GitHub or Google there." : "Then sign in there.";
  const opened = options.openBrowser?.(page) === true;
  // the QR code keeps the left edge: a scanner needs its quiet zone, not an indent
  const body = opened
    ? step([
      "Opening your browser at:",
      `  ${page}`,
      `Check that the page shows the code ${signIn.userCode}, then continue there.`,
      `No browser here? Open ${signIn.verificationUri} on any device and enter that code.`,
      "",
      `Waiting for the sign-in… (expires in ${options.expiresIn}, Ctrl+C to cancel)`,
    ])
    : [
      ...step([`1. On any device, open: ${signIn.verificationUri}`, `2. Enter this code: ${signIn.userCode}   (expires in ${options.expiresIn})`]),
      ...signIn.verificationUriComplete === null ? [] : [...step(["Or scan this to open the page with the code filled in:"]), qr(signIn.verificationUriComplete).replace(/\n+$/, "")],
      ...step([there, "", `Enter the code only if you started ${cli(options)} login yourself.`, "Waiting for the sign-in… (Ctrl+C to cancel)"]),
    ];
  return ["", `Add this PC (${options.label}) to your Ovis account`, "", "1/2  Sign in", ...body, ""].join("\n");
}

/** What `ovis login` ends with once this PC is in the account. */
export function loginClosing(options: LinkOptions): string {
  return `The sign-in was only for this and ends with it; nothing of it is kept on this PC.\nCheck: ${cli(options)} status      Undo: ${cli(options)} logout\n`;
}

const ACCOUNT_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** The value of `name` in `args` (`--account <id>` or `--account=<id>`): "" when it has none, undefined without the flag. */
function flagValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === name) return args[index + 1] ?? "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
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
    const pinned = flagValue(args, "--account");
    if (pinned !== undefined && !ACCOUNT_SHAPE.test(pinned)) {
      options.out(`--account takes your Ovis account's id, or its start as ${cli(options)} status shows it.\n`);
      return 1;
    }
    const confirmed = flagValue(args, "--confirm");
    if (confirmed !== undefined) return await confirmNumber(options, api, confirmed);
    return args.includes("--code") ? await linkWithCode(options, api)
      : await linkToAccount(options, api, provider, { approve: args.includes("--approve"), print: args.includes("--print"), qr: args.includes("--qr") || args.includes("--print"), ...pinned === undefined ? {} : { account: pinned } });
  } catch (error) {
    if (options.signal.aborted) { options.out("Stopped.\n"); return 1; }
    // the account's list refused this PC for want of room (409 directory_full): its code alone says nothing to a person
    const full = error instanceof AccountServiceError && error.code === "directory_full";
    // 409 pc_left: this PC left that account with ovis logout, and its own proof did not come with the listing
    const left = error instanceof AccountServiceError && error.code === "pc_left";
    options.out(`Could not link this PC: ${full ? `Your account holds as many PCs as it can. Remove one in the Ovis app, then run ${cli(options)} add again.`
      : left ? `This PC left that account (${cli(options)} logout), and the Ovis running on it did not prove it is this PC, which listing it again takes. Update Ovis on this PC (Settings → Updates), then run ${cli(options)} login again.`
      : error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
