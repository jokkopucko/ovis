/**
 * Kimi Code's plan limits, read with the sign-in its own CLI keeps (upstream kimi-code,
 * packages/oauth): the OAuth token file `credentials/kimi-code.json` under KIMI_CODE_HOME
 * (default ~/.kimi-code), or the global region's `kimi-code-env-<digest>.json` beside it,
 * against the managed `/usages` endpoint the CLI's own /usage command reads. The token is never
 * refreshed here: an expired one is reported, and the CLI renews its own file the next time it
 * runs.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { UsageCredits, UsageWindow } from "../shared/protocol.ts";
import { epochMs, isoTime, number, parseJson, percent, readText, record, requestJson as usageJson, text, UsageFailed, UsageHttpError, type CredentialHome, type Json, type UsageContext, type UsageProvider } from "./usage.ts";

/** A Kimi API read: the bearer token goes to Kimi's own host and nowhere a redirect names. */
const requestJson = (ctx: UsageContext, url: string, init: RequestInit): Promise<Json> => usageJson(ctx, url, { ...init, redirect: "error" });

// managed-usage.ts:8-9, constants.ts:3, region.ts:29-46
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const GLOBAL_BASE_URL = "https://api.kimi.ai/coding/v1";
const GLOBAL_OAUTH_HOST = "https://auth.kimi.ai";

const stripSlash = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * The token file the CLI scopes to an OAuth host and API base pair: `kimi-code-env-<digest>`,
 * the digest as resolveKimiCodeOAuthKey computes it (managed-kimi-code.ts:308-325), stored by
 * FileTokenStorage as `credentials/<name>.json` (toolkit.ts:112, storage.ts:46).
 */
function scopedName(oauthHost: string, baseUrl: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ oauthHost: stripSlash(oauthHost), baseUrl: stripSlash(baseUrl) }))
    .digest("hex").slice(0, 16);
  return `kimi-code-env-${digest}`;
}

interface KimiCredential { readonly name: string; readonly baseUrl: string }

/**
 * The credentials a Kimi home may hold, each with the API base its token belongs to: the default
 * region and the global region, Kimi's own two. A file the CLI scoped to another pair
 * (KIMI_CODE_BASE_URL / KIMI_CODE_OAUTH_HOST) is never read: its token would go to a host that
 * is not Kimi's.
 */
const CREDENTIALS: readonly KimiCredential[] = [
  { name: "kimi-code", baseUrl: DEFAULT_BASE_URL },
  { name: scopedName(GLOBAL_OAUTH_HOST, GLOBAL_BASE_URL), baseUrl: GLOBAL_BASE_URL },
];

function kimiHomes(ctx: UsageContext): { dir: string; source: string; home: CredentialHome }[] {
  const homes = [{ dir: join(ctx.home, ".kimi-code"), source: "default", home: { kind: "default" } as CredentialHome }];
  const configured = ctx.env["KIMI_CODE_HOME"];
  if (configured !== undefined && configured !== "" && configured !== homes[0]!.dir) {
    homes.push({ dir: configured, source: configured, home: { kind: "dir", dir: configured } });
  }
  return homes;
}

/** Extra Usage as the CLI's /usage shows it: monthly spend against the charge limit (usage-panel.ts:180-228). */
function kimiCredits(value: unknown): UsageCredits | null {
  const wallet = record(value);
  if (record(wallet["balance"])["type"] !== "BOOSTER") return null;
  const amount = number(record(wallet["balance"])["amount"]);
  if (amount === null || amount <= 0) return null;
  const money = (raw: unknown): { cents: number; currency: string } | null => {
    const entry = record(raw);
    const cents = number(entry["priceInCents"]);
    return cents === null ? null : { cents, currency: text(entry["currency"]) ?? "" };
  };
  const limit = money(wallet["monthlyChargeLimit"]);
  const used = money(wallet["monthlyUsed"]);
  const currency = (limit && limit.currency !== "" ? limit.currency : used && used.currency !== "" ? used.currency : null) ?? "USD";
  const capped = wallet["monthlyChargeLimitEnabled"] === true && limit !== null && limit.cents > 0;
  return {
    kind: "spend", currency,
    used: used === null ? null : used.cents / 100,
    limit: capped ? limit.cents / 100 : null,
    used_percent: capped && used !== null ? percent(used.cents / limit.cents * 100) : null,
  };
}

export const kimiUsage: UsageProvider = {
  id: "kimi",
  async signIns(ctx) {
    return kimiHomes(ctx).flatMap(({ dir, source, home }) =>
      CREDENTIALS.flatMap(({ name, baseUrl }) => {
        const wire = record(parseJson(readText(join(dir, "credentials", `${name}.json`))));
        const token = text(wire["access_token"]);
        if (token === null) return [];
        return [{ source: name === "kimi-code" ? source : `${source}:${name}`, home, token, expiresAt: epochMs(wire["expires_at"]), baseUrl, account: null }];
      }));
  },
  async read(ctx, signIn) {
    const baseUrl = signIn.baseUrl ?? DEFAULT_BASE_URL;
    const headers = { authorization: `Bearer ${signIn.token}`, accept: "application/json", "user-agent": "ovis" };
    const body = await requestJson(ctx, `${baseUrl}/usages`, { headers });
    // an answer without `usages` (an error envelope sent as 200) is not a reading: the last one stays
    if (body["usages"] === null || typeof body["usages"] !== "object" || Array.isArray(body["usages"])) throw new UsageFailed("bad_response", `${new URL(baseUrl).host} answered without usages`);
    const usages = record(body["usages"]);
    const limit = (value: unknown, kind: UsageWindow["kind"], scope: string | null): UsageWindow | null => {
      const entry = record(value);
      const ratio = number(entry["used_ratio"]);
      if (ratio === null) return null;
      return { kind, scope, used_percent: percent(ratio * 100), resets_at: isoTime(entry["reset_time"]), starts_at: null };
    };
    const windows = [
      limit(usages["limit_5h"], "session", null),
      limit(usages["limit_7d"], "week", null),
      limit(usages["limit_month_total"], "month", null),
      // the monthly share the code surface used, which the CLI shows as the monthly breakdown (usage-format.ts:71-77)
      limit(usages["limit_month_code"], "month", "Code"),
    ].filter((entry): entry is UsageWindow => entry !== null);
    // The profile names the account; the limits stand without it only when the endpoint is not
    // there (404, managed-userinfo.ts:55-78). Every other failure is raised, so the service keeps
    // the last reading and the account it names: a 429 unchanged, for its Retry-After backoff; a
    // 401 or 403 as a plain error - the sign-in is fine, /usages just answered, and a
    // UsageHttpError of those statuses would be read as an expired sign-in; anything else as is.
    let account = null;
    try {
      const me = await requestJson(ctx, `${baseUrl}/me`, { headers });
      const id = text(me["user_id"]);
      if (id !== null) account = { id, label: text(me["nickname"]) ?? text(me["email"]) ?? text(me["username"]) };
    } catch (error) {
      if (!(error instanceof UsageHttpError)) throw error;
      if (error.status === 401 || error.status === 403) throw new Error(`HTTP ${error.status}`);
      if (error.status !== 404) throw error;
    }
    return { plan: null, windows, credits: kimiCredits(body["boosterWallet"]), account };
  },
};
