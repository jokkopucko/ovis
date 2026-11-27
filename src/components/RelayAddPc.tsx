import "./RelayAddPc.css";

import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { useT, type Translate } from "../lib/i18n.ts";
import { callNative, hasNativeMethod, hasNativePlugin } from "../lib/nativeApp.ts";
import { ACCOUNT_PROVIDERS } from "../lib/account/store.ts";
import { isLoopbackHost, tailnetHost } from "../lib/phone.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";
import { confirmOffline, navigatorOffline } from "../lib/useOffline.ts";

/** The phone app's QR scanner (@capacitor/barcode-scanner, app/package.json) and its SSH screen (Android's OvisSsh). */
const SCANNER = "CapacitorBarcodeScanner";
/** The phone app's shell plugin (app/android HerdrShellPlugin): it opens a PC's address, and says whether Tailscale is on. */
const SHELL = "HerdrShell";
const SSH = "OvisSsh";

const SSH_TARGET = /^(?:ssh:\/\/)?([^\s@/:]+)@([^\s@/:[\]]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?\/?$/i;

/**
 * An SSH login typed where an address goes, `user@host` or `user@host:port` (or `ssh://` with them), as the app's own
 * SSH field reads it (app/web/shell.js `sshOrAddress`): its text as `user@host[:port]`, or null for anything else.
 */
export function sshTarget(text: string): string | null {
  const found = SSH_TARGET.exec(text.trim());
  if (found === null) return null;
  const port = found[3] === undefined ? 22 : Number(found[3]);
  if (port < 1 || port > 65535) return null;
  return `${found[1]}@${found[2]}${port === 22 ? "" : `:${port}`}`;
}

/**
 * Whether this page can hand SSH to the phone app: a PC page (the hosted app's included) never adds an SSH PC itself
 * (OvisSsh answers only the app's own pages), so it asks the app to open its own connect screen with the login filled
 * in (HerdrShell openSshSetup), where the person adds it. An app without that, and a browser, have no SSH here.
 */
export function sshHandoff(): boolean {
  return hasNativePlugin(SSH) && hasNativeMethod("HerdrShell", "openSshSetup");
}

/** Opens the app's own SSH screen, `target` (`user@host[:port]`) filled in, or empty to type one there. */
export function openSshSetup(target: string): Promise<unknown> {
  return callNative("HerdrShell", "openSshSetup", { target });
}

/**
 * An address typed as people write it: `my-pc.tailnet.ts.net`, `192.168.0.12:7421` or a whole URL. A bare IPv4
 * address gets http (a home network's Ovis has no certificate), any other name https; null for anything else.
 */
export function addressOf(text: string): URL | null {
  let value = text.trim();
  // a scheme without its slashes (`http:/pc.local`) is a typo, not a host named after the scheme
  if (value === "" || /^[a-z][a-z0-9+.-]*:(?!\/\/|\d)/i.test(value)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value) ? "http://" : "https://") + value;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? url : null;
  } catch { return null; }
}

/**
 * Whether `hostname` (a URL's) is this device, a home network's or a tailnet's, which opens only from inside it, judged by
 * the name alone (the phone app's own rule, app/web/shell.js `homeHost`): a private or link-local IP, a Tailscale address,
 * a one-word name or a name under .local, .lan, .home.arpa or .internal. Any other name is a public server.
 */
function homeHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.endsWith(".ts.net") || host.startsWith("fd7a:115c:a1e0:")) return true;
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return !host.includes(".") || /\.(local|lan|home\.arpa|internal)$/.test(host);
}

/**
 * Whether opening `url` would send a pairing code and everything typed across the internet unencrypted: plain http to a
 * host that does not look like this device's, a home network's or a tailnet's (the phone app's own rule, `publicHttp`).
 */
export function publicHttp(url: URL): boolean {
  return url.protocol === "http:" && !homeHost(url.hostname);
}

/** how long the Android app asks an address whether it is Ovis before it gives up (PCStore.ANSWER_SECONDS) */
const ANSWER_SECONDS = 20;

/**
 * Why the phone app could not open `url`, from the reason its check gave (`code`, Android's PCStore.check; app/web/shell.js
 * `openFailure` says the same): nothing for a Cancel, otherwise what went wrong and what to do, with Tailscale's own hint
 * for an address that opens only while Tailscale is on. `message`: the app's own words, read only for a not-Ovis answer's
 * HTTP status, never shown.
 */
export function openFailureText(t: Translate, url: URL, code: string | undefined, message: string): string {
  const host = url.host;
  const tailscale = tailnetHost(url.hostname.replace(/^\[|\]$/g, "")) ? ` ${t("This is a Tailscale address, and Tailscale may be off on this phone: turn it on in the Tailscale app.")}` : "";
  switch (code) {
    case "cancelled": return "";
    case "not-ovis": return t("{host} answered{status}, but it is not Ovis: another web server, or herdr itself, which the app cannot open. Open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.", { host, status: /^HTTP \d{3}$/.test(message) ? ` (${message})` : "" });
    case "refused": {
      const said = t("{host} refused the connection: nothing listens there. Ovis has to run on the PC (herdr alone is not enough), and by default it listens only on the PC itself (127.0.0.1). Open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.", { host });
      return isLoopbackHost(url.hostname) ? `${said} ${t("On a phone, localhost and 127.0.0.1 are the phone itself, not your PC.")}` : said;
    }
    case "timeout": return (homeHost(url.hostname)
      ? t("{host} did not answer within {seconds} seconds. The PC may be off, or out of this phone's reach: a home network address does not open over mobile data or another Wi-Fi, and a firewall on the PC can block the port.", { host, seconds: ANSWER_SECONDS })
      : t("Nothing came back from {host} within {seconds} seconds. The server may be down, or this phone's connection (or a VPN on it) may not reach it.", { host, seconds: ANSWER_SECONDS })) + tailscale;
    case "unknown-host": return t("{name} was not found. Check the name, or open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.", { name: url.hostname }) + tailscale;
    // Android: no route to the host, or a network that cannot reach it (PCStore.failureKind)
    case "no-answer": return t("This phone has no way to {host} right now: the PC may be off, or this phone's network (mobile data, another Wi-Fi, or a VPN) does not reach it.", { host }) + tailscale;
    // a reason this page does not know, or none: the app's own words are not the person's language, so none of them
    default: return t("{host} could not be opened. Check the address, and that Ovis runs on that PC.", { host }) + tailscale;
  }
}

/** What opening a PC says while this device has no network (confirmOffline): the phone app's words name the phone. */
export function offlineOpenText(t: Translate): string {
  return hasNativePlugin(SHELL) ? t("Connect this phone to the internet to open the PC.") : t("Connect this device to the internet to open the PC.");
}

/**
 * The PC page a link of this app's origin opens, built from the PC's scope: the page itself (`/s/<id>/`, no query) with
 * its pairing offer, an account's sign-in (signInLink) or neither; null for anything else, a file under the scope too.
 */
function pcPage(url: URL): string | null {
  const serverId = serverIdOfPath(url.pathname);
  if (serverId === null || url.pathname !== serverScopePath(serverId) || url.search !== "") return null;
  const signIn = url.hash.startsWith("#sign-in=") && (ACCOUNT_PROVIDERS as readonly string[]).includes(url.hash.slice("#sign-in=".length));
  if (url.hash !== "" && !signIn && !url.hash.startsWith("#offer=")) return null;
  return url.origin + serverScopePath(serverId) + url.hash;
}

/** One way to add a PC, as a card: its icon, what it is and where it takes the person. */
export function Way({ icon: Icon, title, sub, onClick, action, disabled = false }: { readonly icon: LucideIcon; readonly title: string; readonly sub: string; readonly onClick: () => void; readonly action: string; readonly disabled?: boolean }) {
  return (
    <button type="button" className="relay-add-way" data-action={action} disabled={disabled} onClick={onClick}>
      <span className="relay-add-way-icon"><Icon aria-hidden="true" /></span>
      <span className="relay-add-way-text"><span className="relay-add-way-title">{title}</span><span className="relay-add-way-sub">{sub}</span></span>
      <ChevronRight className="relay-add-way-chevron" aria-hidden="true" />
    </button>
  );
}

/** A PC this device paired, as this device knows it: its saved Ovis too old, or as its last check found it. */
export type SavedPc = { readonly server_id: string; readonly name?: string | undefined; readonly status?: "online" | "off" | "update" | undefined };

/** Whether the phone app around this page can scan a PC's QR code itself (a browser cannot). */
export function canScanQr(): boolean {
  return hasNativePlugin(SCANNER);
}

/**
 * Scans a PC's QR code with the phone app's scanner and hands what it read to `take`; `failed`: the scanner could not
 * run (the camera refused). The plugin's own JS fills these defaults; the page calls the bridge without it (app/web/connect.js).
 */
export function scanQr(t: Translate, take: (url: URL | null) => void, failed: (cause: unknown) => void): void {
  // the Android app asks for the camera itself first (HerdrShell camera): the scanner's own refusal is in English alone
  const camera = hasNativeMethod("HerdrShell", "camera") ? callNative<{ granted?: boolean }>("HerdrShell", "camera") : Promise.resolve({ granted: true });
  camera.then((answer) => {
    if (answer.granted !== true) { failed(new Error(t("Ovis cannot use the camera. Allow it in the phone's Settings, under Apps, Ovis, Permissions."))); return; }
    scan(t, take, failed);
  }, failed);
}

function scan(t: Translate, take: (url: URL | null) => void, failed: (cause: unknown) => void): void {
  void callNative<{ ScanResult?: string }>(SCANNER, "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code on the PC's screen"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 }).then((result) => {
    if (result.ScanResult) take(addressOf(result.ScanResult));
  }, failed);
}

export type AddressOpen = ReturnType<typeof useAddressOpen>;

/**
 * The PC the phone app is asked to open, one at a time for the whole connect screen, which owns it (useConnectScreen):
 * `asking` while the app says whether Tailscale is on, `opening` once its open runs (Android checks the address is Ovis
 * for up to 20 s; iOS opens at once). `view`: the pane it was started from, where a wide screen shows it; a phone shows it
 * in whichever pane is on screen, so it follows the person. A newer attempt, Cancel, its deadline or the connect screen
 * going away replaces it, so what an earlier one answers late opens nothing; a tab or a pane giving way does not.
 */
interface Attempt { readonly id: number; readonly host: string; readonly phase: "asking" | "opening"; readonly view: string }
/**
 * What the last attempt ended on, shown where the attempt was: why it did not open, or Tailscale off on the phone; `other`,
 * the same PC by another way it is saved by, offered by its host (OtherWayButton).
 */
export type OpenOutcome = ({ readonly view: string; readonly kind: "error"; readonly text: string } | { readonly view: string; readonly kind: "tailscale-off" }) & { readonly other?: OtherWay };
/** Another way the same PC is saved by, which a failed or refused open offers: its way's tag, the host it opens, and what it does. */
export interface OtherWay { readonly way: string; readonly host: string; readonly run: () => void }

/** An address that may break onto the next line after each of its dots, before it breaks anywhere else. */
export function atDots(address: string): ReactNode {
  return address.split(".").map((part, at) => at === 0 ? part : <Fragment key={at}>.<wbr />{part}</Fragment>);
}

/**
 * The one button a failed or refused open offers to open the same PC by another way it is saved by: that way's tag, then
 * the host it opens, whole (on a second line rather than cut), so the person sees what will answer, and the same in its
 * accessible name. The host is what the app saved; that it is this PC is only what that host's page told the app.
 */
export function OtherWayButton({ way, host, onClick }: { readonly way: string; readonly host: string; readonly onClick: () => void }) {
  const t = useT();
  const label = t("Open {host}", { host });
  const at = label.indexOf(host);
  return (
    <button type="button" className="btn relay-add-other-way-button" data-action="open-other-way" aria-label={`${label} (${way})`} onClick={onClick}>
      <span className="phone-pc-tag">{way}</span>
      <span className="relay-add-other-way-host">{at < 0 ? label : <>{label.slice(0, at)}{atDots(host)}{label.slice(at + host.length)}</>}</span>
    </button>
  );
}
let attempt: Attempt | null = null;
let outcome: OpenOutcome | null = null;
let attempts = 0;
const watching = new Set<() => void>();
function tell(): void { for (const watch of [...watching]) watch(); }
function setAttempt(next: Attempt | null): void { attempt = next; tell(); }
function setOutcome(next: OpenOutcome | null): void { outcome = next; tell(); }
const watch = (listener: () => void): (() => void) => { watching.add(listener); return () => watching.delete(listener); };
/** The connect screen's attempt and what the last one ended on, as they change. */
export function useOpening(): { readonly pending: Attempt | null; readonly outcome: OpenOutcome | null } {
  const pending = useSyncExternalStore(watch, () => attempt, () => null);
  const ended = useSyncExternalStore(watch, () => outcome, () => null);
  return { pending, outcome: ended };
}
/** Whether the app can stop an open it runs: Android can; iOS, which opens at once, has no cancelOpen. */
export function canStopOpen(): boolean {
  return hasNativeMethod(SHELL, "cancelOpen");
}
/** Stops the attempt there is: one still asking ends here; one opening asks the app to stop, where it can (a call to a method it lacks never settles). */
export function stopAttempt(): void {
  const was = attempt;
  if (was === null) return;
  setAttempt(null);
  if (was.phase === "opening" && canStopOpen()) void callNative(SHELL, "cancelOpen").catch(() => undefined);
}
/** Clears what the last attempt ended on (the person dismissed it, or moved on). */
export function clearOutcome(): void {
  if (outcome !== null) setOutcome(null);
}
/** The connect screen, which owns the attempt: when it goes away, so do its attempt and what the last one ended on. */
export function useConnectScreen(): void {
  useEffect(() => () => { stopAttempt(); clearOutcome(); }, []);
}

/** how long a saved Tailscale PC waits for the app to say whether Tailscale is on before it opens anyway */
const TAILSCALE_WAIT_MS = 1_500;
/** how long an open may run before the page takes it as unanswered: the app's own check gives up after 20 s (PCStore.ANSWER_SECONDS) */
const OPEN_WAIT_MS = 25_000;

/**
 * Whether Tailscale is on in the phone app: only an explicit `on: false` is off; yes where the app cannot tell (no
 * `tailscale`, a check that failed, or no answer within `TAILSCALE_WAIT_MS`).
 */
export async function tailscaleOn(): Promise<boolean> {
  if (!hasNativeMethod(SHELL, "tailscale")) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // fixed wait: an app that does not answer whether Tailscale is on is taken as on, so the open goes ahead
  const late = new Promise<boolean>((done) => { timer = setTimeout(() => done(true), TAILSCALE_WAIT_MS); });
  const asked = callNative<{ on?: boolean }>(SHELL, "tailscale").then((answer) => answer.on !== false, () => true);
  try { return await Promise.race([asked, late]); } finally { clearTimeout(timer); }
}

/**
 * What a scanned or typed address does from one pane (`view`) of the connect screen, whose one attempt it starts
 * (useOpening shows it); `error`: what this opener itself refused (not an address, another app's link, plain http on
 * the internet). A QR the scanner reads after this opener is gone starts nothing.
 */
export function useAddressOpen(view = "page") {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const { pending } = useOpening();
  // the public http address the person was just warned about: opening it again goes ahead
  const warned = useRef<string | null>(null);
  // whether this opener is still on the page: a scan it started that answers later counts only then
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const failed = (cause: unknown): void => { setError(cause instanceof Error ? cause.message : String(cause)); };
  /** The app's open of `url`, as attempt `id`, where the app has it, until its deadline; what it ends on is said only while `id` is still the screen's. */
  const openNow = (url: URL, id: number, other: OtherWay | undefined): void => {
    const more = other === undefined ? {} : { other };
    if (!hasNativeMethod(SHELL, "open")) { setAttempt(null); setOutcome({ view, kind: "error", text: t("This app cannot open a PC by its address. Update the Ovis app.") }); return; }
    // fixed wait: an open the app never answers (no cancelOpen to stop it) holds the screen no longer than the app's own check would
    const deadline = setTimeout(() => {
      if (attempt?.id !== id) return;
      stopAttempt();
      void confirmOffline().then((offline) => setOutcome(offline ? { view, kind: "error", text: offlineOpenText(t) } : { view, kind: "error", text: openFailureText(t, url, "timeout", ""), ...more }));
    }, OPEN_WAIT_MS);
    void callNative(SHELL, "open", { url: url.href, check: true }).then(() => undefined, async (cause: unknown) => {
      if (attempt?.id !== id) return;
      const code = typeof (cause as { code?: unknown } | null)?.code === "string" ? (cause as { code: string }).code : undefined;
      if (code === "cancelled") return;
      // the network went away under the open: that is why, whatever the address answered
      const offline = await confirmOffline();
      setOutcome(offline ? { view, kind: "error", text: offlineOpenText(t) } : { view, kind: "error", text: openFailureText(t, url, code, cause instanceof Error ? cause.message : String(cause)), ...more });
    }).finally(() => {
      clearTimeout(deadline);
      if (attempt?.id === id) setAttempt(null);
    });
  };
  /**
   * What a scanned or typed address does: a pairing link of this app opens at its PC's page, where the pairing asks
   * first, and so does an account PC's standing QR (its page, with the sign-in fragment or none: signInLink); a pairing
   * link of another origin is refused; a PC's own address opens (a public http one only after a warning): the phone app
   * checks it is Ovis first (HerdrShell.open, app/web/connect.js), a browser goes there; anything else says so. In the app
   * one opens at a time: while one opens, another tap waits; one still asking about Tailscale gives way to the new one.
   * `askTailscale`: a saved Tailscale PC, which asks the app first whether Tailscale is on. With no network on this
   * device nothing opens, and it says so (offlineOpenText), never why the address did not answer: while the device says
   * so, the account service is asked first (confirmOffline), and an answer goes on with this same open. `other`: the
   * same PC by another way it is saved by, which an open that fails or is refused (Tailscale off) offers by name.
   */
  const take = (url: URL | null, options: { readonly askTailscale?: boolean; readonly other?: OtherWay } = {}): void => {
    if (url === null) { setError(t("That is not an http or https address.")); return; }
    if (navigatorOffline()) {
      void confirmOffline().then((offline) => {
        if (!live.current) return;
        if (offline) { clearOutcome(); setError(offlineOpenText(t)); } else go(url, options);
      });
      return;
    }
    go(url, options);
  };
  const go = (url: URL, options: { readonly askTailscale?: boolean; readonly other?: OtherWay }): void => {
    const offer = url.hash.startsWith("#offer=");
    if (url.origin === window.location.origin) {
      const page = pcPage(url);
      if (page !== null) window.location.assign(page);
      else setError(t("That is not an http or https address."));
      return;
    }
    if (offer) { setError(t("This pairing link is not this app's. Scan the QR code your PC shows.")); return; }
    if (publicHttp(url) && warned.current !== url.href) {
      warned.current = url.href;
      setError(t("{host} is not on a tailnet or a home network, so plain http would send everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.", { host: url.host }));
      return;
    }
    if (!hasNativePlugin(SHELL)) { setError(null); window.location.assign(url.href); return; }
    if (attempt?.phase === "opening") return;
    setError(null);
    clearOutcome();
    const id = ++attempts;
    const ask = options.askTailscale === true && hasNativeMethod(SHELL, "tailscale");
    setAttempt({ id, host: url.host, phase: ask ? "asking" : "opening", view });
    if (!ask) { openNow(url, id, options.other); return; }
    void tailscaleOn().then((on) => {
      if (attempt?.id !== id) return;
      if (!on) { setAttempt(null); setOutcome({ view, kind: "tailscale-off", ...(options.other ? { other: options.other } : {}) }); return; }
      // the network went away while the app was asked: this attempt ends there, opening nothing
      void confirmOffline().then((offline) => {
        if (attempt?.id !== id) return;
        if (offline) { setAttempt(null); setOutcome({ view, kind: "error", text: offlineOpenText(t) }); return; }
        setAttempt({ id, host: url.host, phase: "opening", view });
        openNow(url, id, options.other);
      });
    });
  };
  /** `run` with what a scan (or its failure) answers, only while this opener is still on the page */
  const ifLive = <T,>(run: (value: T) => void) => (value: T): void => { if (live.current) run(value); };
  return { error, setError, failed, cancel: stopAttempt, take, scanned: ifLive(take), ifLive, pending };
}

/** What this opener itself refused, in its own pane. */
export function OpenError({ open }: { readonly open: AddressOpen }) {
  return open.error === null ? null : <p className="account-error" role="alert">{open.error}</p>;
}

/**
 * The connect screen's attempt, in a pane (`view`): the host being opened, in every pane on screen, with Cancel where it
 * can be stopped (one still asking about Tailscale always; one opening only where the app has cancelOpen); or why the
 * last one did not open, in the pane it was started from (`anyView`: a phone, one pane on screen at a time, says it in
 * whichever that is), a Tailscale-off outcome as the Tailscale-off card. Every place that starts an open draws its end
 * here, so none ends in nothing: an open, the card, or a line.
 */
export function OpenStatus({ view, anyView = false }: { readonly view: string; readonly anyView?: boolean }) {
  const t = useT();
  const { pending, outcome: ended } = useOpening();
  if (pending !== null) {
    return (
      <p className="relay-add-opening" role="status" data-opening="">
        <span className="boot-spinner" aria-hidden="true" />
        <span className="relay-add-opening-text">{t("Opening {host}…", { host: pending.host })}</span>
        {(pending.phase === "asking" || canStopOpen()) && <button type="button" className="btn btn-ghost" onClick={stopAttempt}>{t("Cancel")}</button>}
      </p>
    );
  }
  if (ended === null || !(anyView || ended.view === view)) return null;
  const other = ended.other && (
    <div className="relay-add-other-way">
      <OtherWayButton way={ended.other.way} host={ended.other.host} onClick={() => { const run = ended.other?.run; clearOutcome(); run?.(); }} />
    </div>
  );
  return <>{ended.kind === "error" ? <p className="account-error" role="alert">{ended.text}</p> : <TailscaleOff />}{other}</>;
}

/** With Tailscale off on the phone a Tailscale address opens nothing: one line and Open Tailscale, where the app has it. */
export function TailscaleOff() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="connect-tailscale-off" role="alert" data-tailscale-off="">
      <p className="relay-shell-copy">{t("Turn on Tailscale to connect")}</p>
      {hasNativeMethod(SHELL, "openTailscale") && <button type="button" className="btn btn-primary" onClick={() => { setError(null); callNative(SHELL, "openTailscale").catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}>{t("Open Tailscale")}</button>}
      {error !== null && <p className="account-error">{error}</p>}
    </div>
  );
}

/** An opener's own refusal and the screen's attempt, on a screen of one pane (the plain wait). */
export function OpenState({ open }: { readonly open: AddressOpen }) {
  return <><OpenStatus view="" anyView /><OpenError open={open} /></>;
}

/**
 * A PC's address in one field (`label` names it) and its submit button, then what opening it ended on; `open`: the
 * opener of a screen that has other ways to open a PC beside it, which then shows what opening ended on itself.
 */
export function AddressForm({ label, placeholder, submit: submitLabel, labelShown = false, autoFocus = false, open, ssh = false }: {
  readonly label: string; readonly placeholder: string; readonly submit: string; readonly labelShown?: boolean; readonly autoFocus?: boolean; readonly open?: AddressOpen;
  /** an SSH login typed here goes to the phone app's own SSH screen (sshHandoff) */
  readonly ssh?: boolean;
}) {
  const fieldId = useId();
  const own = useAddressOpen();
  const { setError, failed, take } = open ?? own;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = (event.currentTarget.elements.namedItem("address") as HTMLInputElement).value;
    const login = ssh ? sshTarget(typed) : null;
    if (login !== null) { setError(null); openSshSetup(login).catch(failed); return; }
    take(addressOf(typed));
  };
  return (
    <>
      <form className="relay-add-form" onSubmit={submit} noValidate>
        {labelShown && <label className="relay-shell-field-label" htmlFor={fieldId}>{label}</label>}
        <input id={fieldId} name="address" className="input" type="url" inputMode="url" {...(labelShown ? {} : { "aria-label": label })} placeholder={placeholder} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="url" autoFocus={autoFocus} />
        <button type="submit" className="btn btn-primary">{submitLabel}</button>
      </form>
      {open === undefined && <OpenState open={own} />}
    </>
  );
}
