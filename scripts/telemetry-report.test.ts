import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUERIES, table } from "./telemetry-report.ts";

/** scripts/telemetry-report.ts with a stand-in bunx on a private PATH: no wrangler, no D1. */

const SCRIPT = join(import.meta.dir, "telemetry-report.ts");
const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

async function run(fails: boolean, response = '[{"results":[{"day":"2026-10-18","COUNT(*)":5}],"success":true}]') {
  const scratch = mkdtempSync(join(tmpdir(), "telemetry-report-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  writeFileSync(join(bin, "bunx"), fails
    ? "#!/bin/sh\necho 'You are not authenticated' >&2\nexit 1\n"
    : `#!/bin/sh\necho "$PWD" >> "$SCRATCH/dirs"\necho "$*" >> "$SCRATCH/calls"\necho '${response}'\n`);
  chmodSync(join(bin, "bunx"), 0o755);
  const out = join(scratch, "report.md");
  const child = Bun.spawn([process.execPath, SCRIPT, "--out", out], { env: { PATH: bin, HOME: scratch, SCRATCH: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const calls = existsSync(join(scratch, "calls")) ? readFileSync(join(scratch, "calls"), "utf8").trim().split("\n") : [];
  const dirs = existsSync(join(scratch, "dirs")) ? readFileSync(join(scratch, "dirs"), "utf8").trim().split("\n") : [];
  return { exitCode, output: stdout + stderr, report: existsSync(out) ? readFileSync(out, "utf8") : null, calls, dirs };
}

describe("telemetry report tables", () => {
  it("writes the rows' keys as columns and escapes pipes", () => {
    expect(table([{ a: 1, b: "x|y" }, { a: null, b: "z" }])).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |\n| NULL | z |");
    expect(table([])).toBe("(no rows)");
  });
});

describe("telemetry report queries", () => {
  it("count each screen and way in once per install over 30 days, and add up each day's answers and alerts", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(join(import.meta.dir, "..", "telemetry", "schema.sql"), "utf8"));
    // one today for every seeded row, so a run across UTC midnight seeds no row a day off
    const today = db.query<{ day: string }, []>("SELECT date('now') AS day").get()!.day;
    const day = (back: number) => db.query<{ day: string }, [string, string]>("SELECT date(?, ?) AS day").get(today, `-${back} days`)!.day;
    const insert = db.prepare("INSERT INTO active (day, install_id, version, os, arch, install_method, country, harnesses, usage) VALUES (?, ?, '0.4.20', 'linux', 'x64', 'source', 'KR', '[]', ?)");
    const usage = (surfaces: string[], ingress: string[], answers: number, delivered: number, opened: number) =>
      JSON.stringify({ surfaces, ingress, prompt_answers: answers, alerts_delivered: delivered, alerts_opened: opened });
    insert.run(day(0), "a", usage(["browser", "ios-app"], ["local", "tailscale"], 3, 2, 1));
    // the same install on another day counts once per screen and way in
    insert.run(day(1), "a", usage(["ios-app"], ["tailscale"], 1, 0, 0));
    insert.run(day(0), "b", usage(["ios-app"], ["lan"], 4, 5, 2));
    // a sender from before usage: a day of use, but in no usage table
    insert.run(day(0), "c", null);
    // older than the 30-day tables, still in the daily one
    insert.run(day(40), "d", usage(["mac-app"], ["funnel"], 7, 7, 7));
    const rows = (title: string) => db.query(QUERIES.find((query) => query.title === title)!.sql).all();
    expect(rows("Installs per kind of screen, the last 30 days")).toEqual([{ surface: "ios-app", installs: 2 }, { surface: "browser", installs: 1 }]);
    expect(rows("Installs per way in, the last 30 days")).toEqual([{ ingress: "lan", installs: 1 }, { ingress: "local", installs: 1 }, { ingress: "tailscale", installs: 1 }]);
    expect(rows("Prompt answers and pane alerts per day")).toEqual([
      { day: day(40), installs: 1, prompt_answers: 7, alerts_delivered: 7, alerts_opened: 7 },
      { day: day(1), installs: 1, prompt_answers: 1, alerts_delivered: 0, alerts_opened: 0 },
      { day: day(0), installs: 2, prompt_answers: 7, alerts_delivered: 7, alerts_opened: 3 },
    ]);
    db.close();
  });
});

describe.skipIf(process.platform === "win32")("telemetry report", () => {
  it("runs every query read-only against the remote database, one table each, in order", async () => {
    const result = await run(false);
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.split("--command ")[1])).toEqual([
      "SELECT strftime('%Y-%W', day) AS week, COUNT(*) FROM events WHERE event = 'install' GROUP BY week ORDER BY week;",
      "SELECT day, COUNT(*) FROM active GROUP BY day ORDER BY day;",
      "SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-6 days');",
      "SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-29 days');",
      "SELECT harness.value AS harness, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.harnesses) AS harness WHERE active.day >= date('now', '-29 days') GROUP BY harness.value ORDER BY installs DESC, harness;",
      // the usage tables' results are checked against stored rows above (telemetry report queries)
      ...["Installs per kind of screen, the last 30 days", "Installs per way in, the last 30 days", "Prompt answers and pane alerts per day"].map((title) => QUERIES.find((query) => query.title === title)!.sql),
      "SELECT country, COUNT(*) FROM (SELECT (SELECT country FROM events WHERE install_id = e.install_id AND country IS NOT NULL ORDER BY rowid DESC LIMIT 1) AS country FROM events e GROUP BY install_id) GROUP BY country ORDER BY 2 DESC;",
      "SELECT day, country, COUNT(*) FROM active WHERE day >= date('now', '-27 days') GROUP BY day, country ORDER BY day, country;",
    ]);
    // from telemetry/, where wrangler finds wrangler.toml and the database's id
    const telemetry = join(import.meta.dir, "..", "telemetry");
    expect(new Set(result.dirs)).toEqual(new Set([telemetry]));
    expect(existsSync(join(telemetry, "wrangler.toml"))).toBe(true);
    for (const call of result.calls) expect(call).toStartWith("wrangler d1 execute herdr-web-ui-telemetry --remote --json --command ");
    expect(result.calls.some((call) => /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(call))).toBe(false);
    const headings = [...result.report!.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "New installs per week",
      "Daily active installs (DAU)",
      "Weekly active installs (WAU), the last 7 days",
      "Monthly active installs (MAU), the last 30 days",
      "Installs running each kind of agent, the last 30 days",
      "Installs per kind of screen, the last 30 days",
      "Installs per way in, the last 30 days",
      "Prompt answers and pane alerts per day",
      "Installs per country (last country seen)",
      "Daily active installs per country, the last 28 days",
    ]);
    expect(result.report).toContain("| 2026-10-18 | 5 |");
  });

  it("stops with the login hint when wrangler cannot read the database", async () => {
    const result = await run(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("run bunx wrangler login first");
    expect(result.report).toBeNull();
  });

  for (const success of [false, undefined]) {
    it(`does not write a report when D1 success is ${String(success)}, even with exit 0`, async () => {
      const result = await run(false, JSON.stringify([{ success, results: [] }]));
      expect(result.exitCode).toBe(1);
      expect(result.report).toBeNull();
      expect(result.calls).toHaveLength(1);
    });
  }
});
