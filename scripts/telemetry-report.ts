/**
 * The telemetry counts of telemetry/README.md ("Reading the counts") as one markdown report, plus
 * daily active installs per country for the last 28 days, and the last 7 finished days' button counts
 * (the counts table): for each counter and width, the share of installs that used it and the median
 * range of the middle install among those that did, never a mean, beside the share that were shown the control at all.
 *
 *   bun scripts/telemetry-report.ts --out <file.md> [--html <file.html>]
 *
 * Runs \`bunx wrangler d1 execute herdr-web-ui-telemetry --remote --json\` from telemetry/, so it
 * needs \`bunx wrangler login\` once with the account that owns the database. It only reads.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TELEMETRY_HARNESSES } from "../shared/telemetry.ts";

export const COUNTS_INSTALLS = "Installs that sent button counts, per width, the last 7 finished days";
export const COUNTS_BUCKETS = "Button counts per width: installs that used each, and days per range, the last 7 finished days";
export const COUNTS_SHOWN = "Controls shown, per width: installs that saw each at least once, the last 7 finished days";
export const SWITCHES_BY_AGENT = "Chat/terminal switches by kind of agent and width: installs running it that switched on its panes, the last 7 finished days";
export const SWITCH_DAYS_BY_VERSION = "Install-days with a chat/terminal switch, per version, the last 7 finished days";
export const COUNTER_SHARES = "Button counts per width: share of installs that used each (of: the installs it is a share of), and the middle install's day, each install counted by the lower middle of the days it used it";

export const COUNTS_PER_INSTALL = "Each install's ranges per counter and width (read for the middle install, never printed)";

export const QUERIES: ReadonlyArray<{ title: string; sql: string; hidden?: boolean }> = [
  { title: "New installs per week", sql: "SELECT strftime('%Y-%W', day) AS week, COUNT(*) FROM events WHERE event = 'install' GROUP BY week ORDER BY week;" },
  { title: "Daily active installs (DAU)", sql: "SELECT day, COUNT(*) FROM active GROUP BY day ORDER BY day;" },
  { title: "Weekly active installs (WAU), the last 7 days", sql: "SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-6 days');" },
  { title: "Monthly active installs (MAU), the last 30 days", sql: "SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-29 days');" },
  { title: "Installs running each kind of agent, the last 30 days", sql: "SELECT harness.value AS harness, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.harnesses) AS harness WHERE active.day >= date('now', '-29 days') GROUP BY harness.value ORDER BY installs DESC, harness;" },
  { title: "Installs per kind of screen, the last 30 days", sql: "SELECT surface.value AS surface, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.usage, '$.surfaces') AS surface WHERE active.day >= date('now', '-29 days') AND active.usage IS NOT NULL GROUP BY surface.value ORDER BY installs DESC, surface;" },
  { title: "Installs per way in, the last 30 days", sql: "SELECT way.value AS ingress, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.usage, '$.ingress') AS way WHERE active.day >= date('now', '-29 days') AND active.usage IS NOT NULL GROUP BY way.value ORDER BY installs DESC, ingress;" },
  { title: "Prompt answers and pane alerts per day", sql: "SELECT day, COUNT(*) AS installs, SUM(json_extract(usage, '$.prompt_answers')) AS prompt_answers, SUM(json_extract(usage, '$.alerts_delivered')) AS alerts_delivered, SUM(json_extract(usage, '$.alerts_opened')) AS alerts_opened FROM active WHERE usage IS NOT NULL GROUP BY day ORDER BY day;" },
  { title: "Installs per country (last country seen)", sql: "SELECT country, COUNT(*) FROM (SELECT (SELECT country FROM events WHERE install_id = e.install_id AND country IS NOT NULL ORDER BY rowid DESC LIMIT 1) AS country FROM events e GROUP BY install_id) GROUP BY country ORDER BY 2 DESC;" },
  { title: "Daily active installs per country, the last 28 days", sql: "SELECT day, country, COUNT(*) FROM active WHERE day >= date('now', '-27 days') GROUP BY day, country ORDER BY day, country;" },
  { title: COUNTS_INSTALLS, sql: "SELECT w.width, COUNT(DISTINCT c.install_id) AS installs FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width ORDER BY w.width;" },
  { title: COUNTS_BUCKETS, sql: "SELECT w.width, item.key AS counter, COUNT(DISTINCT c.install_id) AS installs, (SELECT COUNT(DISTINCT c2.install_id) FROM counts c2 WHERE c2.day >= date('now', '-7 days') AND c2.day < date('now') AND (CASE w.width WHEN 'narrow' THEN c2.narrow ELSE c2.wide END) IS NOT NULL) AS of, SUM(item.value = 1) AS days_1_2, SUM(item.value = 2) AS days_3_9, SUM(item.value = 3) AS days_10_29, SUM(item.value = 4) AS days_30_up FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS item WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width, item.key ORDER BY w.width, installs DESC, item.key;" },
  { title: COUNTS_SHOWN, sql: "SELECT w.width, item.value AS control, COUNT(DISTINCT c.install_id) AS installs FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.shown') AS item WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width, item.value ORDER BY w.width, installs DESC, item.value;" },
  { title: COUNTS_PER_INSTALL, hidden: true, sql: "SELECT w.width, item.key AS counter, c.install_id AS install, group_concat(item.value) AS buckets FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS item WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width, item.key, c.install_id;" },
  { title: SWITCHES_BY_AGENT, sql: `SELECT width, agent, running, switched FROM (SELECT w.width AS width, ag.agent AS agent, CASE WHEN ag.agent = 'shell' THEN '-' ELSE (SELECT COUNT(*) FROM (SELECT c.install_id FROM counts c JOIN active a ON a.day = c.day AND a.install_id = c.install_id CROSS JOIN json_each(a.harnesses) AS h WHERE c.day >= date('now', '-7 days') AND c.day < date('now') AND h.value = ag.agent AND CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END IS NOT NULL UNION SELECT c.install_id FROM counts c CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS y WHERE c.day >= date('now', '-7 days') AND c.day < date('now') AND CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END IS NOT NULL AND y.key IN ('view_chat_' || ag.agent, 'view_terminal_' || ag.agent))) END AS running, (SELECT COUNT(DISTINCT c.install_id) FROM counts c CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS x WHERE c.day >= date('now', '-7 days') AND c.day < date('now') AND CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END IS NOT NULL AND x.key IN ('view_chat_' || ag.agent, 'view_terminal_' || ag.agent)) AS switched FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w CROSS JOIN (${[...TELEMETRY_HARNESSES, "shell"].map((agent) => `SELECT '${agent}' AS agent`).join(" UNION ALL ")}) AS ag) WHERE switched > 0 OR (agent <> 'shell' AND running > 0) ORDER BY width, agent = 'shell', running DESC, agent;` },
  { title: SWITCH_DAYS_BY_VERSION, sql: "SELECT c.version, COUNT(*) AS days, SUM(EXISTS (SELECT 1 FROM json_each(c.narrow, '$.counts') AS x WHERE x.key GLOB 'view_*_by_*') OR EXISTS (SELECT 1 FROM json_each(c.wide, '$.counts') AS x WHERE x.key GLOB 'view_*_by_*')) AS days_switched FROM counts c WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY c.version ORDER BY c.version;" },
];

export const BUCKET_RANGES = ["1-2", "3-9", "10-29", "30+"] as const;

const middles = (values: readonly number[]): [number, number] => {
  const sorted = [...values].sort((x, y) => x - y);
  return [sorted[Math.floor((sorted.length - 1) / 2)]!, sorted[Math.floor(sorted.length / 2)]!];
};

export function counterShares(installs: ReadonlyArray<Record<string, unknown>>, buckets: ReadonlyArray<Record<string, unknown>>, perInstall: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const total = new Map(installs.map((row) => [String(row["width"]), Number(row["installs"])]));
  return buckets.map((row) => {
    const width = String(row["width"]), counter = String(row["counter"]);
    const typical = perInstall
      .filter((entry) => String(entry["width"]) === width && String(entry["counter"]) === counter)
      .map((entry) => middles(String(entry["buckets"]).split(",").map(Number))[0]);
    const [low, high] = typical.length === 0 ? [0, 0] : middles(typical);
    const of = row["of"] === undefined ? total.get(width) ?? 0 : Number(row["of"]);
    return { width, counter, installs: row["installs"], of, percent: of === 0 || Number(row["installs"]) > of ? "-" : Math.round(1000 * Number(row["installs"]) / of) / 10, middle_install_day: typical.length === 0 ? "-" : low === high ? BUCKET_RANGES[low - 1]! : `${BUCKET_RANGES[low - 1]} .. ${BUCKET_RANGES[high - 1]}` };
  });
}

export function atDay(sql: string, day: string): string {
  return sql.replaceAll("date('now'", `date('${day}'`);
}

const escapeHtml = (value: unknown) => String(value ?? "NULL").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function html(title: string, sections: ReadonlyArray<{ title: string; rows: ReadonlyArray<Record<string, unknown>> }>): string {
  const body = sections.map(({ title: heading, rows }) => {
    if (!rows.length) return `<h2>${escapeHtml(heading)}</h2><p>(no rows)</p>`;
    const columns = Object.keys(rows[0]!);
    const cell = (column: string, value: unknown) => column === "percent"
      ? `<td class="num"><span class="bar" style="width:${Math.max(0, Math.min(100, Number(value)))}px"></span> ${escapeHtml(value)}%</td>`
      : `<td${typeof value === "number" ? ' class="num"' : ""}>${escapeHtml(value)}</td>`;
    return `<h2>${escapeHtml(heading)}</h2><table><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${columns.map((column) => cell(column, row[column])).join("")}</tr>`).join("")}</table>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#1d2330}table{border-collapse:collapse;margin-bottom:8px}td,th{padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:left}th{background:#f6f7f9}.num{text-align:right}.bar{display:inline-block;height:9px;background:#0ea5e9;border-radius:2px}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>\n`;
}

export function table(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (!rows.length) return "(no rows)";
  const columns = Object.keys(rows[0]!);
  const cell = (value: unknown) => String(value ?? "NULL").replaceAll("|", "\\|");
  return [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`)].join("\n");
}

async function d1(sql: string): Promise<Array<Record<string, unknown>> | null> {
  const child = Bun.spawn(["bunx", "wrangler", "d1", "execute", "herdr-web-ui-telemetry", "--remote", "--json", "--command", sql], { cwd: join(import.meta.dir, "..", "telemetry"), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(out) as Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>;
    const result = parsed[0];
    return result?.success === true ? result.results ?? null : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const option = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    if (at < 0) return undefined;
    const value = process.argv[at + 1];
    if (value === undefined || value.startsWith("--")) { console.error("Usage: bun scripts/telemetry-report.ts --out <file.md> [--html <file.html>]"); process.exit(1); }
    return value;
  };
  const out = option("--out");
  const page = option("--html");
  if (!out) {
    console.error("Usage: bun scripts/telemetry-report.ts --out <file.md> [--html <file.html>]");
    process.exit(1);
  }
  const results: Array<{ title: string; rows: Array<Record<string, unknown>> }> = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const query of QUERIES) {
    const rows = await d1(atDay(query.sql, today));
    if (rows === null) {
      console.error(`telemetry report: "${query.title}" failed: run bunx wrangler login first (in telemetry/), with the account that owns herdr-web-ui-telemetry`);
      process.exit(1);
    }
    results.push({ title: query.title, rows });
  }
  const rowsOf = (title: string) => results.find((result) => result.title === title)?.rows ?? [];
  results.push({ title: COUNTER_SHARES, rows: counterShares(rowsOf(COUNTS_INSTALLS), rowsOf(COUNTS_BUCKETS), rowsOf(COUNTS_PER_INSTALL)) });
  const shown = results.filter(({ title }) => !QUERIES.find((query) => query.title === title)?.hidden);
  const heading = "Telemetry report";
  const note = `Run at ${new Date().toISOString()}. Counts are a trend, not an audit (telemetry/README.md).`;
  writeFileSync(out, [`# ${heading}\n\n${note}`, ...shown.map(({ title, rows }) => `## ${title}\n\n${table(rows)}`)].join("\n\n") + "\n");
  if (page) writeFileSync(page, html(`${heading} · ${note}`, shown));
  console.log(`telemetry report: ${shown.length} tables written to ${out}${page ? ` and ${page}` : ""}`);
}
