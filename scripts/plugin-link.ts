/**
 * `link`: a PC with no screen of its own joins the relay from its terminal (docs/relay.md, "A PC
 * with no screen"). Both ways are the ones its own Settings page offers, through the same routes:
 *
 * - `link`: sign in to the account with the provider's device flow (as a PC's own page does,
 *   src/lib/account/deviceSignIn.ts), list this PC in the account (src/lib/account/addThisPc.ts),
 *   then approve here, after comparing six digits, the device of the account that adds it.
 * - `link --code`: the code to type and the relay QR code that Connect a device shows, renewed
 *   as they run out, until Ctrl+C.
 *
 * It talks only to a server on this machine (a loopback address): approving a device is an act of
 * the PC itself (docs/account.md, "Who may admit a device"), and the sign-in lives in this process.
 */
import qrcode from "qrcode-generator";

import { isLoopbackHost } from "../server/access.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { startDeviceSignIn } from "../src/lib/account/deviceSignIn.ts";
import { NEW_PC_MS } from "../src/lib/account/myPcs.ts";
import { AccountService, DEVICE_PROVIDERS, type DeviceProvider } from "../src/lib/account/service.ts";
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
  /** Ctrl+C */
  readonly signal: AbortSignal;
  readonly fetch?: Fetch;
  readonly serviceFetch?: Fetch;
  readonly now?: () => number;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** How often the waiting screen looks for a device that asks to add this PC. */
const POLL_MS = 2_000;
/** The approve-here window lasts ten minutes; it is opened again a minute before it ends (AccountSection RELIST_MS). */
const RELIST_MS = 9 * 60_000;

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

/** One call to the PC's own API; its error text when it refuses. */
function localApi(options: LinkOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const control = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: options.origin };
  return async <T>(method: "GET" | "POST", path: string, extra: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> => {
    const response = await fetchImpl(`${options.origin}${path}`, {
      method, headers: { ...(method === "POST" ? control : {}), ...options.headers, ...extra.headers },
      ...(method === "POST" ? { body: JSON.stringify(extra.body ?? {}) } : {}),
      signal: extra.signal ?? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
    });
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
  let status = await api<{ phase: string; blocked: string | null }>("GET", "/api/relay");
  if (status.blocked) throw new LocalError(`The Ovis relay cannot run here (${status.blocked}).`);
  if (status.phase === "off") {
    options.out("Turning on the Ovis relay (Settings → Devices and PCs → Ovis relay turns it off again).\n");
    status = await api<{ phase: string; blocked: string | null }>("POST", "/api/relay/start");
    if (status.blocked) throw new LocalError(`The Ovis relay cannot run here (${status.blocked}).`);
  }
  const deadline = now() + ONLINE_MS;
  while (status.phase !== "online") {
    if (now() >= deadline) throw new LocalError("The Ovis relay did not come online in 30 seconds. Check this PC's internet connection and try again.");
    await wait(500, options.signal);
    status = await api<{ phase: string; blocked: string | null }>("GET", "/api/relay");
  }
}

/**
 * A label a requesting device chose, as plain text: its terminal controls (C0, DEL, C1) dropped, so it
 * cannot clear the screen or hide the digits it is shown with.
 */
export const plainLabel = (label: string): string => label.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

/** The next answer, or the abort: Ctrl+C at a prompt stops at once rather than after the next line. */
function answer(lines: AsyncIterator<string>, signal: AbortSignal): Promise<IteratorResult<string>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    lines.next().then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", stop); reject(error); });
  });
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
  const { url } = await api<{ url: string }>("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
  const offer = decodeOffer(url);
  if (offer === null) throw new LocalError("This PC's pairing link did not parse.");
  const label = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const listing: Listing = { serverId: offer.server_id, entry: { label, public_key: publicKey, relay: offer.relay } };
  const listed = (await service.listPcs()).find((pc) => pc.server_id === offer.server_id);
  if (listed === undefined || now() - Date.parse(listed.added_at) < NEW_PC_MS - RELIST_MS) {
    await service.putPc(listing.serverId, listing.entry);
    unlisted.listing = null;
    return listing;
  }
  unlisted.listing = listing;
  await service.deletePc(offer.server_id);
  if (await putListing(service, listing)) unlisted.listing = null;
  return listing;
}

/** Puts the entry back; false when the service did not take it (it stays pending). */
async function putListing(service: AccountService, listing: Listing): Promise<boolean> {
  try { await service.putPc(listing.serverId, listing.entry); return true; } catch { return false; }
}

/** `link`: sign in, list this PC in the account, and approve here the account's device that adds it. */
async function linkToAccount(options: LinkOptions, api: Api, provider: DeviceProvider): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const status = () => api<{ account: string | null }>("GET", "/api/account/status");
  let first: { account: string | null };
  try { first = await status(); } catch (error) {
    if (!(error instanceof LocalError && error.status === 404)) throw error;
    out("The Ovis running on this PC is older than link needs. Update it in Settings → Updates (or reinstall the plugin), then run this again.\n");
    return 1;
  }
  if (first.account !== null) {
    out("This PC is already in your account: every device of your account can use it.\n");
    return 0;
  }
  if (options.accountService === null) {
    out("The account service is off on this PC (OVIS_ACCOUNT_SERVICE_URL=off). Link it with a code instead: run this again with --code.\n");
    return 1;
  }
  await relayOnline(options, api);
  const store = memoryAccountStore();
  const lock = memoryLock();
  const serviceFetch = options.serviceFetch ?? fetch;
  const signIn = await startDeviceSignIn({ service: options.accountService, store, lock, fetch: serviceFetch, now, wait, provider });
  out([
    "",
    `Sign in to your Ovis account with ${provider === "github" ? "GitHub" : "Google"}:`,
    `open ${signIn.verificationUri} on any device and enter the code: ${signIn.userCode}`,
    "Waiting for the sign-in…",
    "",
  ].join("\n"));
  await signIn.finish(signal);
  const service = new AccountService({ store, lock, fetch: serviceFetch, now });
  // a listing a renewal took away and has not put back yet
  const pending: { listing: Listing | null } = { listing: null };
  const unlisted = "This PC could not be listed in your account again just now; it is tried again until it is.\n";
  try {
    const first = await listThisPc(api, service, now, pending);
    if (pending.listing !== null) out(unlisted);
    const name = first.entry.label;
    let listedAt = now();
    out([
      `Signed in. This PC is listed in your account as ${name}.`,
      `On a phone already in your account, open the Ovis app and tap Add on ${name}.`,
      "Its request shows here to approve. Press Ctrl+C to stop.",
      "",
    ].join("\n"));
    const asked = new Set<string>();
    for (;;) {
      const { pairings } = await api<{ pairings: { id: string; label: string; digits: string; intent?: string }[] }>("GET", "/api/relay/pairings");
      for (const pairing of pairings) {
        if (asked.has(pairing.id)) continue;
        asked.add(pairing.id);
        const label = plainLabel(pairing.label);
        const what = pairing.intent === "account" ? "join your account" : "pair with this PC";
        out(`${label} wants to ${what}. Approve it only if its screen shows ${pairing.digits.slice(0, 3)} ${pairing.digits.slice(3)}. Approve? [y/N] `);
        let reply: IteratorResult<string>;
        try { reply = await answer(options.lines, signal); } catch (error) {
          if (signal.aborted) { out("\nStopped. Run this again to keep waiting.\n"); return 1; }
          throw error;
        }
        const decision = !reply.done && /^y(es)?$/i.test(reply.value.trim()) ? "approve" : "decline";
        try {
          await api("POST", "/api/relay/pairing", { body: { id: pairing.id, decision } });
          out(decision === "approve" ? "Approved.\n" : "Declined.\n");
        } catch (error) {
          if (!(error instanceof LocalError)) throw error;
          out(`${label} is no longer waiting.\n`);
        }
      }
      if ((await status()).account !== null) {
        out("This PC is in your account: every device of your account can use it.\n");
        return 0;
      }
      if (pending.listing !== null && await putListing(service, pending.listing)) pending.listing = null;
      if (now() - listedAt >= RELIST_MS) {
        // a renewal that failed after its DELETE went out keeps waiting: the listing is put back above, as after a failed PUT
        try { await listThisPc(api, service, now, pending); } catch (error) {
          if (pending.listing === null) throw error;
        }
        if (pending.listing !== null) out(unlisted);
        listedAt = now();
      }
      try { await wait(POLL_MS, signal); } catch (error) {
        if (signal.aborted) { out("Stopped. Run this again to keep waiting.\n"); return 1; }
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

/** Runs `link [--code] [--google]`; the exit code. */
export async function link(args: readonly string[], options: LinkOptions): Promise<number> {
  let host: string;
  try { host = new URL(options.origin).host; } catch { host = ""; }
  if (!isLoopbackHost(host)) {
    options.out(`The server at ${options.origin} is not on a loopback address. Run link only on the PC itself, with Ovis listening on 127.0.0.1 (HOST unset).\n`);
    return 1;
  }
  const provider = DEVICE_PROVIDERS.find((name) => args.includes(`--${name}`)) ?? "github";
  const api = localApi(options);
  try {
    return args.includes("--code") ? await linkWithCode(options, api) : await linkToAccount(options, api, provider);
  } catch (error) {
    if (options.signal.aborted) { options.out("Stopped.\n"); return 1; }
    options.out(`Could not link this PC: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
