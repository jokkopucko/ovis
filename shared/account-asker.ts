/**
 * Who is asking (docs/account.md, "Who is asking"): what an approval shows of a device the person
 * cannot see, against a phished device code (RFC 8628 section 5.4). The system the device says it
 * runs, and the approximate place the account service saw its request come from (Cloudflare's
 * country and city, never the address).
 */
import { ACCOUNT_LABEL_MAX } from "./account-records.ts";

export const ACCOUNT_OSES = ["ios", "android", "macos", "windows", "linux", "chromeos"] as const;
export type AccountOs = (typeof ACCOUNT_OSES)[number];

export const accountOsOf = (value: unknown): AccountOs | null => ACCOUNT_OSES.find((os) => os === value) ?? null;

export const ACCOUNT_OS_NAMES: Readonly<Record<AccountOs, string>> = { ios: "iOS", android: "Android", macos: "macOS", windows: "Windows", linux: "Linux", chromeos: "ChromeOS" };

export function accountOsOfPlatform(platform: string): AccountOs | null {
  switch (platform) {
    case "darwin": return "macos";
    case "win32": return "windows";
    case "linux": return "linux";
    default: return null;
  }
}

/** `country`: ISO 3166-1 alpha-2; a city comes only with a country. */
export interface AccountPlace { readonly country: string | null; readonly city: string | null }

export interface AccountAsker extends AccountPlace { readonly os: AccountOs | null }

export function placeName(language: string, place: AccountPlace): string | null {
  if (place.country === null) return null;
  const country = new Intl.DisplayNames([language], { type: "region" }).of(place.country) ?? place.country;
  return place.city === null ? country : `${place.city}, ${country}`;
}

/** Unicode's bidirectional formatting controls: in a name they could reorder what is shown after it. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A device's name as one plain line, the form a signed `add` takes (shared/account-records.ts): no
 * control or bidi characters, single spaces, trimmed, at most 48 UTF-16 units of whole characters.
 * Used for names this device sends and for names it shows or signs.
 */
export function accountLabel(text: string): string {
  let label = "";
  for (const char of text.replace(/[\p{Cc}\p{Cs}]/gu, " ").replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim()) {
    if (label.length + char.length > ACCOUNT_LABEL_MAX) break;
    label += char;
  }
  return label.trim();
}
