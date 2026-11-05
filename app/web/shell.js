// Shared by the app's own pages: the native plugin (ios/App/App/HerdrShellPlugin.swift) and
// what an address typed or scanned becomes.

/**
 * The hosted shell's origin (app.ovis.sh), where a PC paired over the Ovis relay opens, at its scope
 * `/s/<server_id>/`. app/scripts/build-web.ts puts in another for a test build (OVIS_APP_URL).
 */
export const APP_ORIGIN = "https://app.ovis.sh";

/** Whether the phone's first language is Korean, the one language the app's own pages have besides English. */
export const korean = /^ko\b/i.test(navigator.language ?? "");

/** The text in the phone's language. */
export function t(en, ko) {
  return korean ? ko : en;
}

/** On a Korean phone, puts in each element's data-ko text, as text: a page with the native bridge has no HTML sink. */
export function localize() {
  if (!korean) return;
  document.documentElement.lang = "ko";
  for (const element of document.querySelectorAll("[data-ko]")) element.textContent = element.dataset.ko;
}

/** Calls the native HerdrShell plugin through Capacitor's bridge. */
export function shell(method, options = {}) {
  return window.Capacitor.nativePromise("HerdrShell", method, options);
}

/**
 * Whether opening url sends a pairing code and everything typed over the internet unencrypted:
 * plain http to an address outside a tailnet, a home network and this phone. The apps allow
 * cleartext to any host, as Android cannot limit it to address ranges.
 */
export function publicHttp(url) {
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    // 10/8, 127/8, 172.16/12, 192.168/16, link-local 169.254/16, and Tailscale's 100.64/10
    return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  }
  // ::1, unique local fc00::/7 (Tailscale's fd7a:115c:a1e0::/48 among them) and link-local fe80::/10
  if (host.includes(":")) return !(host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  // a one-word name (a MagicDNS short name, localhost) or a tailnet or home network name
  return host.includes(".") && !/\.(ts\.net|local|lan|home\.arpa|internal)$/.test(host);
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

/** The offer's `server_id` and `name` from its base64url JSON, or null when it is none. */
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
