/**
 * Keeps one open issue up to date with scripts/ci-flakes.ts's ranked list of the browser scripts that failed or
 * needed a second run (.github/workflows/ci-flakes.yml runs it daily):
 *   bun scripts/ci-flakes-issue.ts [--hours 24] [--repo owner/name] [--dry-run]
 * The issue is the open one titled ISSUE_TITLE that ISSUE_AUTHOR (the workflow's token) opened, created when there is
 * none: an issue anyone else opens under that title is never taken over. It writes through the REST API, never
 * `gh issue edit`, which fails on this repository with a Projects (classic) GraphQL error. --dry-run prints what it
 * would do and the body, and writes nothing.
 */
import { parseArgs } from "node:util";
import { gh, scan, type Scan } from "./ci-flakes.ts";

export const ISSUE_TITLE = "CI flakes: browser scripts that failed or needed a second run";
export const ISSUE_AUTHOR = "github-actions[bot]";
/** Rows past this are left out and counted: 50 rows of capped cells stay below GitHub's 65,536-character body limit. */
export const MAX_ROWS = 50;
const MAX_CELL = 200;

/** Text as a code span inside a table cell: one line, no backtick, its pipes escaped, then at most MAX_CELL characters. */
function code(text: string | null): string {
  if (text === null) return "-";
  const line = text.replace(/\s+/g, " ").replaceAll("`", "'").trim().replaceAll("|", "\\|");
  return `\`${line.length > MAX_CELL ? `${line.slice(0, MAX_CELL - 3)}...` : line}\``;
}

export function issueBody(result: Scan): string {
  const { repo, hours, since, until, stats, rows } = result;
  const unread = stats.runsUnread + stats.logsUnread;
  const lines = [
    "<!-- Written by .github/workflows/ci-flakes.yml (scripts/ci-flakes-issue.ts) once a day: edits here are replaced. -->",
    `Browser scripts in \`ci.yml\` runs from ${since} to ${until} (${hours} hours) that failed, or failed and then passed on their automatic second run (flaky). \`bun scripts/ci-flakes.ts --hours ${hours}\` gives the same list locally.`,
    "",
    "The counts are job attempts, not runs: two attempts of one run count twice. \"Of those on main\" is how many were in runs of the default branch itself; the others were on other branches, where a change under review may have broken the script. A script the lane stopped at its time limit has no failure site: a loaded runner stops several at once. A job that failed outside a script (an upload, a cancellation, the job's own time limit) and a run still going have no row.",
    "",
    "| CI runs | Browser jobs | Passed with no second run | Logs read | Skipped | Job lists not read | Logs not read |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${stats.runs} | ${stats.jobs} | ${stats.jobsClean} | ${stats.logsRead} | ${stats.jobsSkipped} | ${stats.runsUnread} | ${stats.logsUnread} |`,
    "",
  ];
  if (stats.jobs === 0) return [...lines, "No browser job was read."].join("\n");
  if (rows.length === 0) {
    return [...lines, `No browser script failed or needed a second run${unread > 0 ? " in what could be read" : ""}.`].join("\n");
  }
  lines.push("| Failed job attempts | Flaky job attempts | Of those on main | Script | Failure site | Message | Most recent run |", "|---:|---:|---:|---|---|---|---|");
  for (const row of rows.slice(0, MAX_ROWS)) {
    const run = `[${row.runId}](https://github.com/${repo}/actions/runs/${row.runId}) on ${code(row.branch)}`;
    lines.push(`| ${row.failed} | ${row.flaky} | ${row.main} | ${code(row.script)} | ${code(row.site)} | ${code(row.message)} | ${run} |`);
  }
  if (rows.length > MAX_ROWS) lines.push("", `${rows.length - MAX_ROWS} more rows were left out; the command above lists them all.`);
  return lines.join("\n");
}

export interface ListedIssue {
  readonly number: number;
  readonly title: string;
  readonly user: { readonly login: string } | null;
  /** Set on a pull request, which the issues endpoint lists too. */
  readonly pull_request?: unknown;
}

export type IssueAction = { readonly kind: "create" } | { readonly kind: "update"; readonly number: number };

/** Update the oldest open issue titled ISSUE_TITLE exactly that ISSUE_AUTHOR opened, or create one when there is none. */
export function issueAction(open: readonly ListedIssue[]): IssueAction {
  const [number] = open
    .filter((issue) => issue.pull_request === undefined && issue.title === ISSUE_TITLE && issue.user?.login === ISSUE_AUTHOR)
    .map((issue) => issue.number).sort((a, b) => a - b);
  return number === undefined ? { kind: "create" } : { kind: "update", number };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { hours: { type: "string", default: "24" }, repo: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  const result = await scan(Number(values.hours), values.repo);
  const body = issueBody(result);
  const pages: ListedIssue[][] = JSON.parse(await gh(["api", `repos/${result.repo}/issues?state=open&per_page=100`, "--paginate", "--slurp"]));
  const action = issueAction(pages.flat());
  const url = (number: number): string => `https://github.com/${result.repo}/issues/${number}`;
  if (values["dry-run"]) {
    switch (action.kind) {
      case "create": console.log(`Would create an issue in ${result.repo} titled "${ISSUE_TITLE}" with this body:\n`); break;
      case "update": console.log(`Would replace the body of ${url(action.number)} with:\n`); break;
      default: action satisfies never;
    }
    console.log(body);
    return;
  }
  // a write is not repeated on a server error: it may have been done
  switch (action.kind) {
    case "create": {
      const created: { html_url: string } = JSON.parse(await gh(["api", "-X", "POST", `repos/${result.repo}/issues`, "--input", "-"], { attempts: 1, input: JSON.stringify({ title: ISSUE_TITLE, body }) }));
      console.log(`Created ${created.html_url}`);
      break;
    }
    case "update":
      await gh(["api", "-X", "PATCH", `repos/${result.repo}/issues/${action.number}`, "--input", "-", "--silent"], { attempts: 1, input: JSON.stringify({ body }) });
      console.log(`Updated ${url(action.number)}`);
      break;
    default: action satisfies never;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
