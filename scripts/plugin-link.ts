/**
 * `link`: a PC with no screen of its own joins the relay from its terminal (docs/relay.md, "A PC
 * with no screen"). Both ways are the ones its own Settings page offers, through the same routes:
 *
 * - `link` (also `add` and `login`, COMMAND_ALIASES): sign in to the account with a device code (as a PC's own page does,
 *   src/lib/account/deviceSignIn.ts): the Ovis link page's where the service has it, else, or with
 *   `--github` / `--google`, the provider's own device flow. Then list this PC in the account (src/lib/account/addThisPc.ts),
 *   then approve here, after comparing six digits, the device of the account that adds it.
 * - `link --code`: the code to type and the relay QR code that Connect a device shows, renewed
 *   as they run out, until Ctrl+C.
 *
 * It talks only to a server on this machine (a loopback address): approving a device is an act of
 * the PC itself (docs/account.md, "Who may admit a device"), and the sign-in lives in this process.
 */
import { hostname } from "node:os";

import qrcode from "qrcode-generator";

import { isLoopbackHost } from "../server/access.ts";
import { accountOsOfPlatform } from "../shared/account-asker.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { startDeviceSignIn, startLinkPageSignIn } from "../src/lib/account/deviceSignIn.ts";
import { NEW_PC_MS } from "../src/lib/account/myPcs.ts";
import { AccountService, DEVICE_PROVIDERS, offeredProviders, type DeviceProvider } from "../src/lib/account/service.ts";
import { memoryAccountStore, memoryLock } from "../src/lib/account/store.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LinkOptions {
  /** the running server, as the plugin reaches it */
  readonly origin: string;
  /** its token, when it has one */
  readonly headers: Record<string, string>;
  /** the account service the server's pages sign in to; null when the account is off */
  readonly accountService: string | null;
  readonly out: (text: string) => void;
  /** the person's answers, a line at a time */
  readonly lines: AsyncIterator<string>;
  /**
   * `lines` is a terminal a person types at. Anything else (a pipe, a file, a closed stdin) answers nothing, whenever
   * its lines come: nobody compared the digits a line of `yes | ovis add` arrives under. Unset counts as not one.
   */
  readonly terminal?: boolean;
  /** Ctrl+C */
  readonly signal: AbortSignal;
  readonly fetch?: Fetch;
  readonly serviceFetch?: Fetch;
  readonly now?: () => number;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The names `link` also answers to: what a person looks for when a PC is to join their account. */
export const COMMAND_ALIASES: Readonly<Record<string, "link">> = { add: "link", login: "link" };

/** How often the waiting screen looks for a device that asks to add this PC. */
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
 * approves without the request's own digits (`approves`).
 */
const DWELL_MS = 1_500;

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
  constructor(message: string, readonly status = 0) { super(message); }
}

/** The PC's own server gave no answer at all (it is down, restarting, or hung): not a refusal, which is a LocalError. */
class AwayError extends Error {}

/** One call to the PC's own API; its error text when it refuses. */
function localApi(options: LinkOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const control = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: options.origin };
  return async <T>(method: "GET" | "POST", path: string, extra: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${options.origin}${path}`, {
        method, headers: { ...(method === "POST" ? control : {}), ...options.headers, ...extra.headers },
        ...(method === "POST" ? { body: JSON.stringify(extra.body ?? {}) } : {}),
        signal: extra.signal ?? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
      });
    } catch (error) {
      // Ctrl+C is the person's, not the server's
      if (options.signal.aborted) throw error;
      throw new AwayError(`${path}: the Ovis on this PC did not answer (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!response.ok) {
      let message = `${response.status}`;
      try {
        const body = await response.json() as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch { /* a body that is not the app's JSON: the status alone */ }
      throw new LocalError(`${path}: ${message}`, response.status);
    }
    return await response.json() as T;
  };
}

type Api = ReturnType<typeof localApi>;

/** How long a relay that is turned on, or reconnecting, gets to come online. */
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

/** A device that asks to be let in, as the PC lists it (`GET /api/relay/pairings`). */
export interface AskingDevice { readonly label: string; readonly digits: string; readonly intent?: string }

/**
 * The question a terminal asks about a device that wants in: its six digits, to compare with that device's screen,
 * and what to type. The answer that approves carries the request's own digits (`approves`), so it names the request
 * it is for.
 */
export function approvalPrompt(device: AskingDevice): string {
  const what = device.intent === "account" ? "join your account" : "pair with this PC";
  // digits that are not six digits approve nothing (`approves`): the question does not ask for them
  if (!SIX_DIGITS.test(device.digits)) return `${plainLabel(device.label)} wants to ${what}, but its request came without six digits to compare, so it cannot be approved here. Press Enter to decline: `;
  return `${plainLabel(device.label)} wants to ${what}. Approve it only if its screen shows ${device.digits.slice(0, 3)} ${device.digits.slice(3)}. Type ${device.digits.slice(3)} to approve, or press Enter to decline: `;
}

/**
 * Whether a line approves the request that shows `digits`: only those six digits, with or without the space between
 * the halves, or the last three. Anything else declines, a bare Enter and `y` among them: a line begun for another
 * request, or typed ahead of any, does not carry this one's digits. A request whose digits are not six digits is
 * approved by nothing (a bare Enter must never match digits that are missing).
 */
export function approves(line: string, digits: string): boolean {
  if (!SIX_DIGITS.test(digits)) return false;
  const typed = line.replace(/\s/g, "");
  return typed === digits || typed === digits.slice(3);
}

/** What is said of a decline: a person used to y/N is told what approves. */
export const declinedNote = (line: string | null): string =>
  line !== null && /^y(es)?$/i.test(line.trim()) ? "Declined: only a request's digits approve it, not y.\n" : "Declined.\n";

/** The next answer, or the abort: Ctrl+C at a prompt stops at once rather than after the next line. */
function answer(lines: AsyncIterator<string>, signal: AbortSignal): Promise<IteratorResult<string>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    lines.next().then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", stop); reject(error); });
  });
}

/** The lines of an input that is not a terminal: none. */
const NO_LINES: AsyncIterator<string> = { next: () => Promise.resolve({ value: undefined, done: true }) };

/** A line the terminal handed over. */
interface Line {
  readonly text: string;
  /** the request whose prompt was on the screen when the line came; null when none was */
  readonly under: object | null;
  /** when it came */
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
    /** the lines that came since the last call */
    take: (): Line[] => got.splice(0),
    /** nothing more comes: the input ended (a pipe, Ctrl+D) or its reading failed (`failed`, Ctrl+C among them) */
    get ended() { return ended; },
    get failed() { return failed; },
    /** settles with the next line, or the end of the input */
    arrived: (): Promise<void> => new Promise((resolve) => { if (got.length > 0 || ended) resolve(); else wake = resolve; }),
  };
}

const groups = (id: string): string => id.match(/.{1,4}/g)?.join(" ") ?? id;

const remaining = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** `--code`: the code and the QR code, as Connect a device shows them, until Ctrl+C. */
async function linkWithCode(options: LinkOptions, api: Api): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  await relayOnline(options, api);
  let asked = false;
  // the six-digit code the QR code last carried: only that pairing is taken back, not one started since
  let shown: string | null = null;
  try {
    for (;;) {
      asked = true;
      // until this round's offer names its code, the pending pairing is the one this round asks for
      shown = null;
      // the code first: it starts a new pairing, which the offer then carries (RelayPanel CompactRelay);
      // the offer comes whether the code did or not, since its QR code still pairs
      let code: { code: string; expires_at: string; server_id: string } | null = null;
      let refused = "";
      try { code = await api<{ code: string; expires_at: string; server_id: string }>("POST", "/api/relay/code"); } catch (error) {
        if (!(error instanceof LocalError)) throw error;
        refused = error.message;
      }
      const offer = await api<{ url: string; expires_at: string }>("POST", "/api/relay/offer");
      const decoded = decodeOffer(offer.url);
      if (decoded === null) throw new LocalError("The relay's pairing link did not parse.");
      shown = decoded.code ?? null;
      const until = Math.min(code === null ? Infinity : Date.parse(code.expires_at), Date.parse(offer.expires_at));
      const left = remaining(Math.max(0, until - now()));
      out([
        "",
        ...code !== null
          ? [`Code to type: ${code.code}   (works once, expires in ${left})`, "On the other device, open app.ovis.sh, choose Pair with a code and type it,", "or scan this QR code with the phone's camera:"]
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
    if (asked) await takeBack(api, out, shown);
  }
  return 0;
}

/**
 * Takes back what --code showed, however it ends (Ctrl+C, an error): the six-digit code the QR code
 * carries, and with it the typed code bound to it. With a signal of its own, since Ctrl+C aborted the
 * command's. `code` names the pairing it showed, so one started since (in Settings, on another device)
 * stays; null when no QR code came, and then whatever is pending ends, as the typed code it asked for
 * started it. An Ovis from before /api/devices/pair/cancel can take back the typed code only.
 */
async function takeBack(api: Api, out: (text: string) => void, code: string | null): Promise<void> {
  const signal = AbortSignal.timeout(5_000);
  try {
    await api("POST", "/api/devices/pair/cancel", { signal, ...code === null ? {} : { body: { code } } });
    out("Stopped: the code and the QR code no longer work.\n");
  } catch (error) {
    if (error instanceof LocalError && error.status === 404) {
      await api("POST", "/api/relay/code/cancel", { signal }).catch(() => undefined);
      out("Stopped: the code no longer works. The QR code works until it runs out, as this Ovis cannot take it back.\n");
      return;
    }
    out(`Stopped, but the code could not be taken back (${error instanceof Error ? error.message : String(error)}): it works until it runs out.\n`);
  }
}

/** This PC's entry in the account's directory. */
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

/** Asks this PC for its approve-here window, and reads the entry to list from the link it answers with. */
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

/** Puts the entry back; false when the service did not take it (it stays pending). */
async function putListing(service: AccountService, listing: Listing): Promise<boolean> {
  try { await service.putPc(listing.serverId, listing.entry); return true; } catch { return false; }
}

/** The start of an account's id, enough to tell two accounts apart on a terminal line. */
const shortId = (account: string): string => plainLabel(account).slice(0, 12);

/**
 * `link`: sign in, list this PC in the account, and approve here the account's device that adds it. It
 * ends well only once this PC is in the account that signed in and that account's other devices are in.
 */
async function linkToAccount(options: LinkOptions, api: Api, forced: DeviceProvider | undefined): Promise<number> {
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
    // whose account it is cannot be told before a sign-in
    if (first.enrolling !== true) {
      out(`This PC is already in an Ovis account (${shortId(first.account)}).\n`);
      return 0;
    }
    // an earlier run added it and stopped before the account's other devices were in: that needs no sign-in to wait for
    out(`This PC is already in an Ovis account (${shortId(first.account)}), but its account's other devices are not in yet. Open the Ovis app on the phone that added it. Waiting for them; press Ctrl+C to stop.\n`);
    const stopAt = now() + WAITING_MS;
    for (;;) {
      await wait(POLL_MS, signal);
      let again: { account: string | null; enrolling?: boolean } | null = null;
      // a server that is restarting answers again in a moment
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
  // only on: online waits until the account is named, which a relay asking for a pass needs first
  await relayOn(options, api);
  const store = memoryAccountStore();
  const lock = memoryLock();
  const serviceFetch = options.serviceFetch ?? fetch;
  // the Ovis link page where the service has it (one code, GitHub or Google picked there); a provider's own device page otherwise, or when named
  const offer = forced === undefined ? await offeredProviders(options.accountService, ["github"], { fetch: serviceFetch }) : null;
  // the link page shows who is asking (docs/account.md, "Who is asking"): this PC's name and system
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
      "Then continue with GitHub or Google there. Waiting for the sign-in…",
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
  // the account that signed in: the one this PC must end up in
  const signedIn = (await service.session())?.account ?? null;
  // a listing a renewal took away and has not put back yet
  const pending: { listing: Listing | null } = { listing: null };
  const unlisted = "This PC could not be listed in your account again just now; it is tried again until it is.\n";
  // the request the terminal asks about: one at a time, and the waiting goes on while it is unanswered.
  // `shownAt`: when its prompt, with its digits, first was on the screen
  let open: { readonly id: string; readonly label: string; readonly digits: string; readonly prompt: string; shownAt: number | null } | null = null;
  try {
    if (signedIn === null) throw new LocalError("The sign-in did not last. Run this again.");
    const first = await listThisPc(api, service, now, pending);
    if (pending.listing !== null) out(unlisted);
    // a renewal's listing not put back yet goes back first: an account that does not list the PC gives it no pass
    if (pending.listing !== null && await putListing(service, pending.listing)) { pending.listing = null; await nameRelayAccount(api, service); }
    try { await relayOnline(options, api); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      throw new LocalError(`This PC stays listed in your account, but its Ovis relay is not online yet (${error.message}) Run this again once it is.`);
    }
    const name = first.entry.label;
    let listedAt = now();
    let openedAt = listedAt;
    const stopAt = listedAt + WAITING_MS;
    // the window is asked for only while it would end by the time this run stops, so it never outlives the 30 minutes
    const mayOpen = () => now() <= stopAt - WINDOW_MS;
    let enrollingSaid = false;
    // this PC is in the account that signed in: nothing is left to approve, so the window and the listing rest
    let added = false;
    // the PC's own server stopped answering (a restart, an update): it is waited for rather than ending the sign-in
    let away = false;
    out([
      `Signed in. This PC is listed in your account as ${name}.`,
      `On a device already signed in to this account (the Ovis app or app.ovis.sh), choose Add on ${name}.`,
      "Its request shows here to approve. Press Ctrl+C to stop.",
      "",
    ].join("\n"));
    // Read from here on, before anything is asked: a line typed ahead (the terminal kept those of the sign-in) comes
    // now, under no request, and answers none. Not sooner: a run in the background is stopped by its first read of
    // the terminal, and by now the PC is listed and the person was told what to do.
    // What is not a terminal is never read: it has ended, as far as answers go
    const keys = typing(options.terminal === true ? options.lines : NO_LINES, signal, () => open !== null && open.shownAt !== null ? open : null, now);
    // said once: from then on every request is declined as it shows
    let endSaid = options.terminal !== true;
    if (endSaid) out("This is not run in a terminal, so no request can be answered here: each is declined as it shows. Run this in a terminal to approve one (over ssh, run ssh -t).\n");
    // it is not this account's PC: its entry there, whose Add could not work, goes, and nothing puts it back
    const elsewhere = async (account: string): Promise<number> => {
      pending.listing = null;
      const unlistedThere = await service.deletePc(first.serverId).then(() => true, () => false);
      // its relay pass is asked under the account it is in, not the one that signed in here
      await api("POST", "/api/account/relay-account", { body: { account } }).catch(() => undefined);
      say(`This PC joined another Ovis account (${shortId(account)}), not the one you signed in to (${shortId(signedIn)}). ${unlistedThere ? "It was taken off the list of the account you signed in to." : "It could not be taken off the list of the account you signed in to; remove it there."} If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
      return 1;
    };
    // the run's last listing was made
    let lastListed = false;
    // the looks at the end of the time a window may be asked for (LAST_MS)
    const lastLooks = () => mayOpen() && now() >= stopAt - WINDOW_MS - LAST_MS;
    const asked = new Set<string>();
    // the line that answers the request asked about: one that came after its prompt was shown
    let reply: string | null = null;
    // the cursor stands after the prompt: what is said next starts on a line of its own
    let atPrompt = false;
    const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
    // A request left the screen unanswered. The terminal hands a line over only when Enter is pressed, and it is
    // marked then: what was typed at that request's prompt and not sent comes with the next Enter, under whatever
    // is asked by then. So the next line handed over answers nothing, whenever it comes and whatever it says
    let held = false;
    // The lines that came since the last look. Only one typed under the prompt of the request asked about, once that
    // was on the screen long enough to compare its digits (DWELL_MS), answers it. Every other line is dropped and said
    // to be: the first after a request went away unanswered (`held`), one typed while nothing was asked, before the
    // prompt showed, or right as it did (a key pressed twice). None of them is ever kept for a later request
    const sort = (): void => {
      let dropped: string | null = null;
      for (const line of keys.take()) {
        // the Enter that sent the line ended the prompt's
        atPrompt = false;
        if (held) {
          held = false;
          dropped = `a request went away while it may have been typed.${open === null ? "" : " Answer again for the request shown now."}`;
          continue;
        }
        if (open !== null && line.under === open && open.shownAt !== null) {
          if (line.at - open.shownAt >= DWELL_MS) {
            // a second line at one prompt: the first is the answer
            reply ??= line.text;
            continue;
          }
          // one that came too soon does not stand in the way of the answer typed after it
          if (reply === null) dropped = "it came as the request showed, too soon to have compared its digits. Compare them, then answer again.";
          continue;
        }
        dropped = open === null ? "no request is waiting for an answer."
          : "it was typed before the request shown now was asked about. Answer again for that one.";
      }
      if (dropped !== null) say(`That line answered nothing: ${dropped}\n`);
    };
    for (;;) {
      try {
        if (away && !added && !mayOpen()) {
          // one unanswered call is not a restart, and the PC may have been added meanwhile: that is looked at first
          let back: { account: string | null } | null = null;
          try { back = await status(); } catch (error) {
            if (!(error instanceof AwayError)) throw error;
          }
          if (back === null || back.account === null) {
            // a server that restarted has no window, and this run may not open one that would outlive it
            say("The Ovis on this PC stopped answering, too close to this run's 30 minutes to open its approval window again. Run this again once it is back.\n");
            return 1;
          }
          // in another account: said as such below, never counted as added to this one
          added = back.account === signedIn;
          if (!added) return await elsewhere(back.account);
        }
        sort();
        // a reading that failed (not Ctrl+C, which the catch below takes) ends the run when it does, not at the next request
        if (keys.failed !== undefined) throw keys.failed;
        if (keys.ended && !endSaid) {
          endSaid = true;
          say("The terminal's input ended (Ctrl+D): no request can be answered here any more, so each is declined as it shows. Run this again to answer them.\n");
        }
        if (away) {
          // the first call that is answered again: a server that restarted has no window, so it is asked for at once
          if (!added) await api("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
          else await status();
          openedAt = now();
          away = false;
          say("The Ovis on this PC answers again.\n");
        }
        if (open !== null && open.shownAt !== null && (reply !== null || keys.ended)) {
          const { id, label, digits } = open;
          const line = reply;
          open = null;
          reply = null;
          // what is said next follows the answer's Enter, or the prompt itself when the input ended
          atPrompt = false;
          // only the request's own digits approve it; an input that ended (Ctrl+D), or is no terminal, declines
          const decision = line !== null && approves(line, digits) ? "approve" : "decline";
          try {
            await api("POST", "/api/relay/pairing", { body: { id, decision } });
            out(decision === "approve" ? "Approved.\n" : declinedNote(line));
          } catch (error) {
            if (error instanceof AwayError) {
              // whether it was taken is not known: the request is asked about again while it still waits, never answered by itself
              asked.delete(id);
              out(`Your answer may not have reached the Ovis on this PC. ${label} is asked about again if it is still waiting.\n`);
            }
            if (!(error instanceof LocalError)) throw error;
            out(`${label} is no longer waiting.\n`);
          }
        }
        const { pairings } = await api<{ pairings: { id: string; label: string; digits: string; intent?: string }[] }>("GET", "/api/relay/pairings");
        const shown = open;
        if (shown !== null && !pairings.some((pairing) => pairing.id === shown.id)) {
          // it ran out, was answered elsewhere, or the server restarted: its prompt ends, and so does a line typed for it
          say(`${shown.label} is no longer waiting.\n`);
          open = null;
          reply = null;
          // what was handed over until now came while it was asked about, and answers nothing any more
          sort();
          // what was typed at its prompt and not sent is still in the terminal: the next line handed over is dropped
          if (shown.shownAt !== null) held = true;
        }
        const next = open === null ? pairings.find((pairing) => !asked.has(pairing.id)) : undefined;
        if (next !== undefined) {
          asked.add(next.id);
          open = { id: next.id, label: plainLabel(next.label), digits: next.digits, prompt: approvalPrompt(next), shownAt: null };
        }
        const joined = await status();
        if (joined.account !== null && joined.account !== signedIn) return await elsewhere(joined.account);
        if (joined.account !== null && joined.enrolling !== true) {
          say(`This PC is in your account (${shortId(joined.account)}): every device of your account can use it.\n`);
          return 0;
        }
        added = joined.account !== null;
        // in the account, while the device that added it still brings in the account's other devices
        if (added && !enrollingSaid) {
          enrollingSaid = true;
          say("Added. Bringing in your account's other devices…\n");
        }
        // a listing a renewal took away goes back, also once this PC is in the account: unlisted, it gets no relay pass
        if (pending.listing !== null && now() < stopAt && await putListing(service, pending.listing)) pending.listing = null;
        if (!added && now() < stopAt) {
          const last = lastLooks();
          let opened = false;
          // also once at the run's end: the card on the account's devices then shows as new until the run is all but over, as the window does
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
            // the window alone, not the listing: a server that restarted meanwhile takes requests again
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
      // what came during the look, before the prompt goes out: none of it was typed at a prompt not yet shown
      sort();
      // shown first, or again under what was said since (not under its own answer)
      if (open !== null && !atPrompt && reply === null) {
        open.shownAt ??= now();
        out(open.prompt);
        atPrompt = true;
      }
      const answered = open !== null && (reply !== null || keys.ended);
      // the answer is already there: it is sent before any waiting
      // (not while the PC's server is away: nothing can be sent, and looking again at once would spin)
      if (!away && answered) continue;
      try {
        if (open === null || answered) await wait(POLL_MS, signal);
        else {
          // the poll's wait ends early when a line comes
          const early = new AbortController();
          const pause = wait(POLL_MS, AbortSignal.any([signal, early.signal]));
          const first = await Promise.race([pause.then(() => "waited" as const), keys.arrived().then(() => "typed" as const)]);
          if (first === "typed") { pause.catch(() => undefined); early.abort(); }
          signal.throwIfAborted();
        }
      } catch (error) {
        if (signal.aborted) { say("Stopped. Run this again to keep waiting.\n"); return 1; }
        throw error;
      }
    }
  } finally {
    // a listing a renewal took away is put back before the sign-in that can put it ends
    if (pending.listing !== null && !await putListing(service, pending.listing)) out("This PC dropped out of your account's list; run link again to list it.\n");
    // the sign-in was only for this: it ends with it, and nothing of it stays on the PC
    await service.signOut().catch(() => out("The sign-in could not be ended at the account service; it ends by itself when it runs out.\n"));
  }
}

/** Runs `link [--code] [--github | --google]` (also `add` and `login`); the exit code. */
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
    return args.includes("--code") ? await linkWithCode(options, api) : await linkToAccount(options, api, provider);
  } catch (error) {
    if (options.signal.aborted) { options.out("Stopped.\n"); return 1; }
    options.out(`Could not link this PC: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
