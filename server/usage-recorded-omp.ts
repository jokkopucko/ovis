/**
 * Claude's limits as Oh My Pi recorded them. While it runs, Oh My Pi reads the limits of each account it is signed
 * in to about every five minutes and keeps every report in its store: `usage_history` in agent.db, one row per limit
 * (as Oh My Pi 18.14 to 18.19 write it, packages/ai/src/auth/sqlite-credential-store.ts):
 *   recorded_at    epoch ms the report was read; the rows of one report share it
 *   provider       "anthropic" for Claude
 *   account_key    Oh My Pi's own name for the sign-in the report was read with
 *   account_id     the Claude account's uuid, the id Claude Code's .claude.json names too
 *   email
 *   limit_id       "anthropic:5h", "anthropic:7d", "anthropic:7d:<model>", "anthropic:extra"
 *   label          "Claude 7 Day (Fable)"
 *   used_fraction  0 to 1; null when the provider stated none
 *   resets_at      epoch ms; null when the provider stated none
 *
 * That table is all this reads. The same file holds Oh My Pi's sign-ins (`auth_credentials`): nothing here names
 * that table, and the file is only read.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RecordedContext, RecordedReading, RecordedSource, RecordedWindow } from "./usage-recorded.ts";
import { RECORDED_STALE_AFTER_MS } from "../shared/usage.ts";
import { AHEAD_MS, byLength, claudeLimit, readStore, resetOf } from "./usage-recorded-pi.ts";

const DAY_MS = 86_400_000;
/** A week is the longest window read here: a row older than that, with a day to spare, records none that still runs. */
const SINCE_MS = 7 * DAY_MS + DAY_MS;
/**
 * The newest rows looked through for each sign-in's latest report. Oh My Pi keeps a row an hour for each limit of each
 * sign-in, about a thousand in the eight days read: this is twenty sign-ins' worth, and what a stopped sign-in last
 * recorded is not pushed out by the rows of the others.
 */
const MAX_ROWS = 20_000;

/** `+provider` keeps each search on the index by time. */
const shaped = (row: string): string => `
  +${row}.provider = 'anthropic'
  AND typeof(${row}.recorded_at) = 'integer' AND (${row}.used_fraction IS NULL OR typeof(${row}.used_fraction) IN ('real', 'integer'))
  AND typeof(${row}.account_key) = 'text' AND length(${row}.account_key) <= 512
  AND typeof(${row}.account_id) = 'text' AND length(${row}.account_id) BETWEEN 1 AND 128
  AND typeof(${row}.limit_id) = 'text' AND length(${row}.limit_id) <= 128
  AND typeof(${row}.label) = 'text' AND length(${row}.label) <= 256
  AND (${row}.email IS NULL OR (typeof(${row}.email) = 'text' AND length(${row}.email) <= 320))
  AND (${row}.resets_at IS NULL OR typeof(${row}.resets_at) = 'integer')`;

const ROWS = `
  WITH latest AS (
    SELECT account_key AS series, max(recorded_at) AS at
    FROM (SELECT account_key, recorded_at FROM usage_history AS seen WHERE ${shaped("seen")} AND seen.recorded_at BETWEEN ? AND ? ORDER BY seen.recorded_at DESC LIMIT ?)
    GROUP BY account_key
  )
  SELECT report.recorded_at, report.account_key, report.account_id, report.email, report.limit_id, report.label, report.used_fraction, report.resets_at
  FROM latest JOIN usage_history AS report ON report.recorded_at = latest.at
  WHERE report.account_key = latest.series AND ${shaped("report")}
  ORDER BY report.recorded_at DESC`;

interface HistoryRow {
  readonly recorded_at: number;
  readonly account_key: string;
  readonly account_id: string;
  readonly email: string | null;
  readonly limit_id: string;
  readonly label: string;
  readonly used_fraction: number | null;
  readonly resets_at: number | null;
}

/**
 * Where Oh My Pi keeps agent.db, as it finds it itself (packages/utils/src/dirs.ts): in PI_CODING_AGENT_DIR, else in
 * $XDG_DATA_HOME/omp once that folder exists (Linux and macOS), else in ~/.omp/agent, where PI_CONFIG_DIR may give
 * that folder another name. Oh My Pi takes that name as it is; Gajae Code trims its own and passes over one that climbs
 * out of the home: each reader follows its tool, so that it looks where the tool writes.
 */
function storePath(ctx: RecordedContext): string {
  const agentDir = ctx.env["PI_CODING_AGENT_DIR"];
  if (agentDir) return join(resolve(agentDir), "agent.db");
  const data = ctx.platform === "linux" || ctx.platform === "darwin" ? ctx.env["XDG_DATA_HOME"] : undefined;
  if (data && existsSync(join(data, "omp"))) return join(data, "omp", "agent.db");
  return join(ctx.home, ctx.env["PI_CONFIG_DIR"] || ".omp", "agent", "agent.db");
}

/**
 * Oh My Pi keeps a series per sign-in (`account_key`), and may hold one account under two of them: the account is
 * then given once, by the series read last whose latest report holds a limit shown here, never as a mix of two.
 */
function latestReports(rows: readonly HistoryRow[]): RecordedReading[] {
  const series = new Map<string, { accountId: string; label: string | null; readAt: number; windows: RecordedWindow[] }>();
  for (const row of rows) {
    const report = series.get(row.account_key) ?? { accountId: row.account_id, label: row.email?.trim() || null, readAt: row.recorded_at, windows: [] };
    series.set(row.account_key, report);
    if (row.used_fraction === null) continue;
    const limit = claudeLimit(row.limit_id, row.label);
    if (limit !== null) report.windows.push({ ...limit, usedPercent: row.used_fraction * 100, resetsAt: resetOf(row.resets_at, row.recorded_at, limit.seconds) });
  }
  const accounts = new Map<string, RecordedReading>();
  for (const { accountId, label, readAt, windows } of series.values()) {
    if (windows.length > 0 && !accounts.has(accountId)) accounts.set(accountId, { accountId, label, readAt, windows: windows.sort(byLength) });
  }
  return [...accounts.values()];
}

export const ompRecorded: RecordedSource = {
  by: "omp",
  staleAfterMs: RECORDED_STALE_AFTER_MS.omp,
  read(ctx) {
    const now = ctx.now();
    const rows = readStore(storePath(ctx), (db) => db.query<HistoryRow, [number, number, number]>(ROWS).all(now - SINCE_MS, now + AHEAD_MS, MAX_ROWS));
    return latestReports(rows ?? []);
  },
};
