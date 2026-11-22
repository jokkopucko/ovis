export const APP_ORIGIN = "https://app.ovis.sh";

export const ACCOUNT_SIGN_IN = true;

/** The account service, which names the sign-ins it offers (`GET /v1/providers`), and those the app can draw, in its order. */
export const ACCOUNT_SERVICE = "https://account.ovis.sh";
export const ACCOUNT_PROVIDERS = ["github", "google", "apple"];

/** The sign-ins a `/v1/providers` answer names, in the app's order, or null for an answer that names nothing readable. */
export function listedProviders(body) {
  // the hosted app's own reading (src/lib/account/store.ts): an answer without both lists names nothing
  if (typeof body !== "object" || body === null || !Array.isArray(body.providers) || !Array.isArray(body.device)) return null;
  return ACCOUNT_PROVIDERS.filter((provider) => body.providers.includes(provider));
}

export const korean = /^ko\b/i.test(navigator.language ?? "");

export function t(en, ko) {
  return korean ? ko : en;
}

/** On a Korean phone, puts in each element's data-ko text, as text: a page with the native bridge has no HTML sink. */
export function localize() {
  if (!korean) return;
  document.documentElement.lang = "ko";
  for (const element of document.querySelectorAll("[data-ko]")) element.textContent = element.dataset.ko;
  for (const element of document.querySelectorAll("[data-ko-label]")) element.setAttribute("aria-label", element.dataset.koLabel);
}

export function shell(method, options = {}) {
  const call = window.Capacitor.nativePromise("HerdrShell", method, options);
  if (method !== "open") return call;
  // a PC's page draws its own bars, on the app's dark start: they go back to light icons before it opens, and follow
  // this screen again when it did not open (refused, cancelled), as the screen stays
  barsFor(false);
  return call.catch((err) => { barsForScreen(); throw err; });
}

/** The bars back to this screen's colours: an open that did not happen (refused, or cancelled before it answered). */
export function barsForScreen() {
  if (LIGHT !== null) barsFor(LIGHT.matches);
}

const LIGHT = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;

/**
 * The system bars' icons for the screen's colours: Android takes them from the page's theme-color (MainActivity,
 * BAR_COLOR_SCRIPT), iOS from Capacitor's SystemBars, set to light icons for the app (capacitor.config.json). Only the
 * app's own screens are ever light (shell.css), so only they ask for dark icons, and every PC opens with light ones.
 */
function barsFor(light) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? "#eeeae2" : "#12100e";
  // on iOS a call to a plugin the app lacks never settles (src/lib/nativeApp.ts, hasNativePlugin): asked only when announced
  if (window.Capacitor?.getPlatform?.() === "ios" && (window.Capacitor.PluginHeaders ?? []).some((header) => header.name === "SystemBars")) {
    window.Capacitor.nativePromise("SystemBars", "setStyle", { style: light ? "LIGHT" : "DARK" }).catch(() => undefined);
  }
}

/** The app's own screens follow the phone's light or dark mode, the system bars with them. */
export function followScheme() {
  if (LIGHT === null) return;
  const apply = () => barsFor(LIGHT.matches);
  LIGHT.addEventListener("change", apply);
  apply();
}

/**
 * What Manage on the connect screen says about an SSH PC (an entry of the Android OvisSsh plugin's
 * `list`): its address, how the phone signs in there, and its host key, or that the key was forgotten
 * on purpose and is confirmed again on Set up again.
 */
export function sshDetails(pc) {
  const address = `${pc.user}@${pc.host}${pc.port === 22 ? "" : `:${pc.port}`}`;
  const how = pc.auth === "imported"
    ? t(`Signs in with a pasted ${pc.keyType ? `${pc.keyType} ` : ""}key`, `붙여 넣은 ${pc.keyType ? `${pc.keyType} ` : ""}키로 로그인`)
    : t("Signs in with this phone's key", "이 휴대폰의 키로 로그인");
  const hostKey = pc.fingerprint
    ? t(`Host key ${pc.hostKeyAlgorithm} ${pc.fingerprint}`, `호스트 키 ${pc.hostKeyAlgorithm} ${pc.fingerprint}`)
    : t("Host key forgotten: Set up again shows the key it has now, to check and confirm.", "호스트 키를 지웠습니다: 다시 설정에서 지금의 키를 보고 확인하세요.");
  return { address, how, hostKey, confirmed: Boolean(pc.fingerprint) };
}

/**
 * Whether opening url sends a pairing code and everything typed over the internet unencrypted:
 * plain http to an address that does not look like a tailnet's, a home network's or this phone's.
 * homeHost judges by the name or address alone: a dotless or .local name counts as home even if DNS
 * sends it to a public server, so this is a heuristic, not proof. The apps allow
 * cleartext to any host, as Android cannot limit it to address ranges.
 */
export function publicHttp(url) {
  return url.protocol === "http:" && !homeHost(url.hostname);
}

/** Whether `hostname` (a URL's) is this phone itself: localhost, 127.0.0.0/8 or ::1. */
export function loopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1";
}

/** Whether `hostname` is a MagicDNS name or a Tailscale IP (100.64.0.0/10, fd7a:115c:a1e0::/48), which opens only while Tailscale is on; error.html has the same test. */
export function tailnetHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.match(/^100\.(\d+)\.\d+\.\d+$/);
  return host.endsWith(".ts.net") || (ipv4 !== null && Number(ipv4[1]) >= 64 && Number(ipv4[1]) <= 127) || host.startsWith("fd7a:115c:a1e0:");
}

/**
 * Whether `hostname` is an address of a home network or a tailnet, which opens only from inside it:
 * this phone itself, a private or link-local IP, a Tailscale address, a one-word name or a name
 * under .local, .lan, .home.arpa or .internal. Any other name is a public server. error.html has
 * the same test.
 */
export function homeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (loopbackHost(host) || tailnetHost(host)) return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    // 10/8, 172.16/12, 192.168/16 and link-local 169.254/16 (127/8 and Tailscale's 100.64/10 above)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // unique local fc00::/7 and link-local fe80::/10 (::1 above)
  if (host.includes(":")) return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  // a one-word name (a MagicDNS short name) or a home network name
  return !host.includes(".") || /\.(local|lan|home\.arpa|internal)$/.test(host);
}

export const ANSWER_SECONDS = 20;

export function openFailure(url, code, message) {
  const host = url.host;
  const tailscale = tailnetHost(url.hostname) ? " " + t(
    "This is a Tailscale address, and Tailscale may be off on this phone: turn it on in the Tailscale app.",
    "Tailscale 주소입니다. 이 휴대폰에서 Tailscale이 꺼져 있을 수 있으니 Tailscale 앱에서 연결을 켜세요.",
  ) : "";
  const where = t(
    "Open the address Ovis shows under Settings → Phone & devices on the PC.",
    "PC의 Ovis에서 설정 → 폰 및 기기에 표시된 주소를 여세요.",
  );
  switch (code) {
    case "cancelled": return "";
    case "not-ovis": {
      const answer = /^HTTP \d{3}$/.test(message ?? "") ? ` (${message})` : "";
      return t(
        `${host} answered${answer}, but it is not Ovis: another web server, or herdr itself, which the app cannot open. ${where}`,
        `${host}이(가) 응답했지만${answer} Ovis가 아닙니다. 다른 웹 서버이거나, 앱이 열 수 없는 herdr 자체입니다. ${where}`,
      );
    }
    case "refused": return refusedHelp(url, host);
    case "timeout": return (homeHost(url.hostname) ? t(
      `${host} did not answer within ${ANSWER_SECONDS} seconds. The PC may be off, or out of this phone's reach: a home network address does not open over mobile data or another Wi-Fi, and a firewall on the PC can block the port.`,
      `${host}이(가) ${ANSWER_SECONDS}초 안에 응답하지 않았습니다. PC가 꺼져 있거나 이 휴대폰에서 닿지 않을 수 있습니다. 집 네트워크 주소는 모바일 데이터나 다른 Wi-Fi에서 열리지 않고, PC의 방화벽이 포트를 막을 수도 있습니다.`,
    ) : t(
      `Nothing came back from ${host} within ${ANSWER_SECONDS} seconds. The server may be down, or this phone's connection (or a VPN on it) may not reach it.`,
      `${ANSWER_SECONDS}초 동안 ${host}에서 아무 응답도 오지 않았습니다. 서버가 꺼져 있거나, 이 휴대폰의 연결(또는 VPN)이 서버에 닿지 않을 수 있습니다.`,
    )) + tailscale;
    case "unknown-host": return t(
      `${url.hostname} was not found. Check the name, or open the address Ovis shows under Settings → Phone & devices on the PC.`,
      `${url.hostname}을(를) 찾지 못했습니다. 이름을 확인하거나, PC의 Ovis에서 설정 → 폰 및 기기에 표시된 주소를 여세요.`,
    ) + tailscale;
    default: return t(`${host} could not be reached: ${message}`, `${host}에 연결할 수 없습니다: ${message}`) + tailscale;
  }
}

function refusedHelp(url, host) {
  const text = t(
    `${host} refused the connection: nothing listens there. Ovis has to run on the PC (herdr alone is not enough), and by default it listens only on the PC itself (127.0.0.1). Open the address Ovis shows under Settings → Phone & devices on the PC.`,
    `${host}이(가) 연결을 거부했습니다. 그 주소에서 기다리는 것이 없습니다. PC에서 Ovis가 실행 중이어야 하고(herdr만으로는 안 됩니다), Ovis는 기본으로 PC 자신(127.0.0.1)에서만 기다립니다. PC의 Ovis에서 설정 → 폰 및 기기에 표시된 주소를 여세요.`,
  );
  return loopbackHost(url.hostname) ? text + " " + t(
    "On a phone, localhost and 127.0.0.1 are the phone itself, not your PC.",
    "휴대폰에서 localhost와 127.0.0.1은 PC가 아니라 휴대폰 자신입니다.",
  ) : text;
}

/**
 * What the user typed or scanned, as the URL to open, or null. A missing scheme becomes
 * http for an IPv4 address (a tailnet or LAN IP, served plain) and https for a name.
 * A pairing link (`?pair=CODE`, the PC's QR code) keeps its code.
 */
export function parseAddress(text) {
  let value = String(text).trim();
  if (value === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value) ? "http://" : "https://") + value;
  let url;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  return url;
}

const OFFER = "#offer=";
const SCOPE = /^\/s\/([0-9a-f]{32})\/?$/;

/**
 * What `url` (from parseAddress) opens through the Ovis relay, or null for a PC's own address.
 * A PC's page on the app's origin, `/s/<server_id>/`, with its pairing offer (`#offer=`, the QR code
 * the PC shows for the relay) or without (a PC saved before), is `{ url, scope, name }`: the address
 * to open, the fragment kept, the scope the app saves the PC under, and its label from the offer.
 * Anything else is `{ error }`: "foreign-offer" for an offer on another origin, which only the app's
 * origin may take, "bad-offer" for an offer that does not name this scope's PC, and "not-a-pc" for
 * another page of the app's origin. The hosted shell checks the offer in full before it pairs.
 */
export function relayLink(url, appOrigin = APP_ORIGIN) {
  if (url.origin !== new URL(appOrigin).origin) return url.hash.startsWith(OFFER) ? { error: "foreign-offer" } : null;
  const serverId = SCOPE.exec(url.pathname)?.[1];
  if (serverId === undefined) return { error: "not-a-pc" };
  const scope = `${url.origin}/s/${serverId}/`;
  if (url.hash === "") return { url: scope, scope, name: undefined };
  if (!url.hash.startsWith(OFFER)) return { error: "not-a-pc" };
  const offer = offerOf(url.hash.slice(OFFER.length));
  if (offer === null || offer.server_id !== serverId) return { error: "bad-offer" };
  return { url: scope + url.hash, scope, name: offer.name };
}

function offerOf(payload) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(payload) || payload.length % 4 === 1) return null;
  let offer;
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    offer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch { return null; }
  if (typeof offer !== "object" || offer === null || offer.v !== 1 || typeof offer.server_id !== "string") return null;
  if (offer.name !== undefined && (typeof offer.name !== "string" || offer.name.length > 64)) return null;
  return { server_id: offer.server_id, name: offer.name === "" ? undefined : offer.name };
}
