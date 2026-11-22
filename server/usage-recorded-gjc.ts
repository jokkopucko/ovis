/**
 * Claude's limits as Gajae Code keeps them. Gajae Code reads the limits of each account it is signed in to at most
 * every five minutes while it runs, and keeps each sign-in's last report for a day in its store: `cache` in agent.db
 * (as Gajae Code 0.18 to 0.20 write it, packages/ai/src/auth-storage.ts), one row per sign-in:
 *   key         "usage_cache:report:anthropic:<base url, or default>:oauth|account:<uuid>|email:<email>|org:<uuid>",
 *               followed by "|schema:<n>" from 0.20: the sign-in the report was read with. Its account is the Claude
 *               account's uuid, the id Claude Code's .claude.json names too
 *   value       JSON, { value, expiresAt }: `value` is the report, or null where the read failed
 *   expires_at  epoch seconds until which Gajae Code keeps the row
 * A report (packages/ai/src/usage.ts) holds provider "anthropic", fetchedAt (epoch ms), limits of { id, label,
 * window: { resetsAt }, amount: { usedFraction } } under the ids Oh My Pi records too, and metadata. The account id
 * in that metadata is the organization's wherever the provider names one, so the account is taken from the key alone.
 *
 * This is Gajae Code's cache and not a history: one report per sign-in, read as it is. That table is all this reads.
 * The same file holds Gajae Code's sign-ins (`auth_credentials`): nothing here names that table, and the file is only read.
 */
import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { RecordedContext, RecordedReading, RecordedSource, RecordedWindow } from "./usage-recorded.ts";
import { RECORDED_STALE_AFTER_MS } from "../shared/usage.ts";
import { AHEAD_MS, byLength, claudeLimit, EPOCH_MS_FROM, readStore, resetOf } from "./usage-recorded-pi.ts";

const PREFIX = "usage_cache:report:anthropic:";
const AFTER_PREFIX = "usage_cache:report:anthropic;";
const MAX_ROWS = 200;
const MAX_VALUE_LENGTH = 16_384;
const MAX_LIMITS = 32;

const ROWS = `
  SELECT key, value
  FROM cache
  WHERE key >= ? AND key < ?
    AND typeof(key) = 'text' AND length(key) <= 1024
    AND typeof(value) = 'text' AND length(value) <= ${MAX_VALUE_LENGTH}
    AND typeof(expires_at) = 'integer' AND expires_at > ?
  ORDER BY key
  LIMIT ?`;

interface CacheRow {
  readonly key: string;
  readonly value: string;
}

interface Report {
  readonly accountId: string;
  readonly label: string | null;
  readonly readAt: number;
  readonly windows: RecordedWindow[];
}

/**
 * Where Gajae Code keeps agent.db, as it finds it itself (packages/utils/src/dirs.ts): in GJC_CODING_AGENT_DIR or its
 * older name PI_CODING_AGENT_DIR, else in $XDG_DATA_HOME/gjc once that folder exists (Linux and macOS), else in ~/.gjc/agent,
 * where GJC_CONFIG_DIR, or its older name PI_CONFIG_DIR, may give that folder another name.
 */
function storePath(ctx: RecordedContext): string {
  const agentDir = ctx.env["GJC_CODING_AGENT_DIR"] || ctx.env["PI_CODING_AGENT_DIR"];
  if (agentDir) return join(resolve(agentDir), "agent.db");
  const data = ctx.platform === "linux" || ctx.platform === "darwin" ? ctx.env["XDG_DATA_HOME"] : undefined;
  if (data && existsSync(join(data, "gjc"))) return join(data, "gjc", "agent.db");
  return join(ctx.home, configDirName(ctx.env), "agent", "agent.db");
}

/** The name of Gajae Code's folder under the home. As Gajae Code does, a name that climbs out of the home is passed over. */
function configDirName(env: RecordedContext["env"]): string {
  for (const name of ["GJC_CONFIG_DIR", "PI_CONFIG_DIR"]) {
    const value = env[name]?.trim();
    if (value && !normalize(value).split(/[\\/]/).includes("..")) return value;
  }
  return ".gjc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signInOf(key: string): { accountId: string; email: string | null } | null {
  const [kind, ...parts] = key.split("|");
  const isOAuthSignIn = kind?.endsWith(":oauth") === true;
  if (!isOAuthSignIn) return null;
  const part = (name: string): string | null => parts.find((entry) => entry.startsWith(`${name}:`))?.slice(name.length + 1) || null;
  const accountId = part("account");
  return accountId === null || accountId.length > 128 ? null : { accountId, email: part("email") };
}

function windowOf(limit: unknown, readAt: number): RecordedWindow | null {
  if (!isRecord(limit) || typeof limit["id"] !== "string" || typeof limit["label"] !== "string") return null;
  const amount = limit["amount"];
  const used = isRecord(amount) ? amount["usedFraction"] : undefined;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const known = claudeLimit(limit["id"], limit["label"]);
  if (known === null) return null;
  const window = limit["window"];
  const reset = isRecord(window) && typeof window["resetsAt"] === "number" ? window["resetsAt"] : null;
  return { ...known, usedPercent: used * 100, resetsAt: resetOf(reset, readAt, known.seconds) };
}

function reportOf(row: CacheRow, now: number): Report | null {
  const signIn = signInOf(row.key);
  if (signIn === null) return null;
  let entry: unknown;
  try { entry = JSON.parse(row.value); } catch { return null; }
  const report = isRecord(entry) ? entry["value"] : null;
  if (!isRecord(report) || report["provider"] !== "anthropic" || !Array.isArray(report["limits"])) return null;
  const readAt = report["fetchedAt"];
  if (typeof readAt !== "number" || !Number.isFinite(readAt) || readAt < EPOCH_MS_FROM || readAt > now + AHEAD_MS) return null;
  const metadata = report["metadata"];
  const email = isRecord(metadata) ? metadata["email"] : undefined;
  const windows = report["limits"].slice(0, MAX_LIMITS).flatMap((limit) => windowOf(limit, readAt) ?? []);
  return { accountId: signIn.accountId, label: typeof email === "string" && email.length > 0 && email.length <= 320 ? email : signIn.email, readAt, windows: windows.sort(byLength) };
}

export const gjcRecorded: RecordedSource = {
  by: "gjc",
  staleAfterMs: RECORDED_STALE_AFTER_MS.gjc,
  read(ctx) {
    const now = ctx.now();
    const rows = readStore(storePath(ctx), (db) => db.query<CacheRow, [string, string, number, number]>(ROWS).all(PREFIX, AFTER_PREFIX, Math.floor(now / 1000), MAX_ROWS));
    // Gajae Code may hold one account under two sign-ins: it is given once, by the report read last that holds a limit shown here
    const reports = (rows ?? []).flatMap((row) => reportOf(row, now) ?? []).filter((report) => report.windows.length > 0).sort((a, b) => b.readAt - a.readAt);
    const accounts = new Map<string, RecordedReading>();
    for (const report of reports) if (!accounts.has(report.accountId)) accounts.set(report.accountId, report);
    return [...accounts.values()];
  },
};
