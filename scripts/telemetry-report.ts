/**
 * The telemetry counts of telemetry/README.md ("Reading the counts") as one markdown report, plus
 * daily active installs per country for the last 28 days.
 *
 *   bun scripts/telemetry-report.ts --out <file.md>
 *
 * Runs \`bunx wrangler d1 execute herdr-web-ui-telemetry --remote --json\` from telemetry/, so it
 * needs \`bunx wrangler login\` once with the account that owns the database. It only reads.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const QUERIES: ReadonlyArray<{ title: string; sql: string }> = [
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
];

/** A markdown table of D1 result rows; a row's keys are the columns. */
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
  const at = process.argv.indexOf("--out");
  const out = at >= 0 ? process.argv[at + 1] : undefined;
  if (!out) {
    console.error("Usage: bun scripts/telemetry-report.ts --out <file.md>");
    process.exit(1);
  }
  const sections = [`# Telemetry report\n\nRun at ${new Date().toISOString()}. Counts are a trend, not an audit (telemetry/README.md).`];
  for (const query of QUERIES) {
    const rows = await d1(query.sql);
    if (rows === null) {
      console.error(`telemetry report: "${query.title}" failed: run bunx wrangler login first (in telemetry/), with the account that owns herdr-web-ui-telemetry`);
      process.exit(1);
    }
    sections.push(`## ${query.title}\n\n${table(rows)}`);
  }
  writeFileSync(out, sections.join("\n\n") + "\n");
  console.log(`telemetry report: ${QUERIES.length} tables written to ${out}`);
}
