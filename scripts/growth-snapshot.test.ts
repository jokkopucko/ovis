import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/growth-snapshot.ts against a stand-in gh on a private PATH: nothing reaches GitHub. The
 * stand-in's answers carry a login, a referrer and a path that must never reach the output.
 */

const SCRIPT = join(import.meta.dir, "growth-snapshot.ts");
const LOGIN = "stand-in-login-7f3a";
const REFERRER = "stand-in-referrer.example";
const PATH_SEEN = "/stand-in/secret-path";
const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

function standIn(mode: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "growth-snapshot-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  const page1 = JSON.stringify(mode === "two-pages" || mode.startsWith("page2-")
    ? Array.from({ length: 100 }, (_, i) => ({ starred_at: "2026-09-30T10:00:00Z", user: { login: `${LOGIN}-${i}` } }))
    : [
      { starred_at: "2026-10-01T10:00:00Z", user: { login: LOGIN } },
      { starred_at: "2026-10-01T12:00:00Z", user: { login: LOGIN + "-2" } },
      { starred_at: "2026-10-03T08:00:00Z", user: { login: LOGIN + "-3" } },
    ]);
  const page2 = JSON.stringify(mode === "two-pages" ? [{ starred_at: "2026-10-02T10:00:00Z", user: { login: LOGIN } }] : []);
  const deny = (name: string) => `echo "gh: ${name} needs push access (HTTP 403)" >&2; exit 1`;
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  *"stargazers?"*) case "$*" in
    *"-H Accept: application/vnd.github.star+json"*) ;;
    *) echo '[{"login":"${LOGIN}"}]'; exit 0 ;;
  esac ;;
esac
case "$*" in
  *"repos/o/r/traffic/views"*) ${mode === "all-403" ? deny("views") : `echo '{"count":42,"uniques":7,"views":[]}'`} ;;
  *"repos/o/r/traffic/clones"*) ${mode === "one-403" || mode === "all-403" ? deny("clones") : `echo '{"count":3,"uniques":2,"clones":[]}'`} ;;
  *"repos/o/r/traffic/popular/referrers"*) ${mode === "all-403" ? deny("referrers") : `echo '[{"referrer":"${REFERRER}","count":9,"uniques":4}]'`} ;;
  *"repos/o/r/traffic/popular/paths"*) ${mode === "all-403" ? deny("paths") : `echo '[{"path":"${PATH_SEEN}","title":"t","count":5,"uniques":3}]'`} ;;
  *"stargazers?per_page=100&page=1"*) echo '${page1}' ;;
  *"stargazers?per_page=100&page=2"*) ${mode.startsWith("page2-") ? `echo "gh: ${LOGIN} (HTTP ${mode.slice(6)})" >&2; exit 1` : `echo '${page2}'`} ;;
  *"stargazers?per_page=100&page="*) echo '[]' ;;
  *"repos/o/r") ${mode === "repo-fails" ? `echo "gh: Not Found (HTTP 404)" >&2; exit 1` : `echo '{"stargazers_count":3,"forks_count":1,"subscribers_count":2}'`} ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  return scratch;
}

async function run(mode: string, scratch = standIn(mode)) {
  const out = join(scratch, "out");
  const child = Bun.spawn([process.execPath, SCRIPT, "--out", out, "--repo", "o/r"], { env: { PATH: join(scratch, "bin"), HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const files = existsSync(out) ? readdirSync(out).sort() : [];
  const snapshotFile = files.find((file) => file.startsWith("snapshot-"));
  const snapshot = snapshotFile ? JSON.parse(readFileSync(join(out, snapshotFile), "utf8")) : null;
  const csv = files.includes("stars-by-day.csv") ? readFileSync(join(out, "stars-by-day.csv"), "utf8") : null;
  return { exitCode, output: stdout + stderr, files, snapshot, csv };
}

describe.skipIf(process.platform === "win32")("growth snapshot", () => {
  it("stops encryption before source deletion when tar fails", async () => {
    const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../.github/workflows/growth-snapshot.yml"), "utf8")) as {
      jobs: { snapshot: { steps: Array<{ name?: string; shell?: string; run?: string }> } };
    };
    const encrypt = workflow.jobs.snapshot.steps.find((step) => step.name === "Encrypt it");
    if (!encrypt?.run) throw new Error("Missing encryption step");
    const scratch = standIn("ok");
    mkdirSync(join(scratch, "growth"));
    for (const [name, script] of [["tar", "exit 1"], ["openssl", "exit 0"]] as const) {
      writeFileSync(join(scratch, "bin", name), `#!/bin/sh\n${script}\n`);
      chmodSync(join(scratch, "bin", name), 0o755);
    }
    symlinkSync("/bin/rm", join(scratch, "bin", "rm"));
    // Match Actions: explicit bash adds pipefail, unlike its implicit bash -e shell.
    const flags = encrypt.shell === "bash" ? ["--noprofile", "--norc", "-e", "-o", "pipefail"] : ["-e"];
    const child = Bun.spawn(["/bin/bash", ...flags, "-c", encrypt.run], {
      cwd: scratch, env: { PATH: join(scratch, "bin"), GROWTH_SNAPSHOT_KEY: "test-only" },
      stdout: "ignore", stderr: "ignore",
    });
    expect(await child.exited).not.toBe(0);
    expect(existsSync(join(scratch, "growth"))).toBe(true);
  });

  it("records counts, traffic and stars by day, with a running total", async () => {
    const result = await run("ok");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.totals).toEqual({ stargazers_count: 3, forks_count: 1, subscribers_count: 2 });
    expect(result.snapshot.views.count).toBe(42);
    expect(result.snapshot.referrers[0].referrer).toBe(REFERRER);
    expect(result.snapshot.stars_by_day).toEqual({ "2026-10-01": 2, "2026-10-03": 1 });
    expect(result.csv).toBe("date,new_stars,cumulative\n2026-10-01,2,2\n2026-10-03,1,3\n");
  });

  it("reads every page of stargazers", async () => {
    const result = await run("two-pages");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.stars_by_day).toEqual({ "2026-09-30": 100, "2026-10-02": 1 });
    expect(result.csv).toBe("date,new_stars,cumulative\n2026-09-30,100,100\n2026-10-02,1,101\n");
  });

  for (const status of ["403", "429"]) {
    for (const reused of [false, true]) {
      it(`fails with 3 without publishing incomplete stars after page 2 returns ${status}, ${reused ? "reused" : "fresh"} output`, async () => {
        const scratch = standIn(`page2-${status}`);
        const out = join(scratch, "out");
        if (reused) {
          mkdirSync(out);
          writeFileSync(join(out, "snapshot-previous.json"), '{"previous":true}\n');
          writeFileSync(join(out, "stars-by-day.csv"), "previous CSV\n");
        }
        const result = await run(`page2-${status}`, scratch);
        expect(result.exitCode).toBe(3);
        expect(result.files).toEqual(reused ? ["snapshot-previous.json", "stars-by-day.csv"] : []);
        expect(result.snapshot).toEqual(reused ? { previous: true } : null);
        expect(result.csv).toBe(reused ? "previous CSV\n" : null);
        expect(result.output).toContain(`(${status})`);
        expect(result.output).not.toContain(LOGIN);
      });
    }
  }

  for (const failure of ["write", "replace"]) it(`does not publish new JSON when the CSV ${failure} fails`, async () => {
    const scratch = standIn("ok");
    const out = join(scratch, "out");
    mkdirSync(out);
    const preload = join(scratch, "fail-csv.ts");
    if (failure === "replace") {
      // A directory cannot be replaced by a CSV, regardless of uid or permissions.
      mkdirSync(join(out, "stars-by-day.csv"));
      writeFileSync(preload, "");
    } else {
      writeFileSync(join(out, "stars-by-day.csv"), "previous CSV\n");
      writeFileSync(preload, `import { mock } from "bun:test";
import * as fs from "node:fs";
const write = fs.writeFileSync;
mock.module("node:fs", () => ({
  ...fs,
  writeFileSync(path, ...args) {
    if (String(path).endsWith("stars-by-day.csv")) throw new Error("Injected CSV write failure");
    return write(path, ...args);
  },
}));
`);
    }
    const snapshot = join(out, "snapshot-previous.json");
    writeFileSync(snapshot, '{"previous":true}\n');
    const child = Bun.spawn([process.execPath, "--preload", preload, SCRIPT, "--out", out, "--repo", "o/r"], {
      env: { PATH: join(scratch, "bin"), HOME: scratch }, stdout: "ignore", stderr: "ignore",
    });
    expect(await child.exited).toBe(1);
    expect(readdirSync(out).sort()).toEqual(["snapshot-previous.json", "stars-by-day.csv"]);
    expect(readFileSync(snapshot, "utf8")).toBe('{"previous":true}\n');
    if (failure === "write") expect(readFileSync(join(out, "stars-by-day.csv"), "utf8")).toBe("previous CSV\n");
  });

  it("keeps going when one traffic endpoint is refused", async () => {
    const result = await run("one-403");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.clones).toEqual({ error: "403" });
    expect(result.snapshot.views.count).toBe(42);
  });

  it("fails with 2 when every traffic endpoint is refused", async () => {
    const result = await run("all-403");
    expect(result.exitCode).toBe(2);
    for (const key of ["views", "clones", "referrers", "paths"]) expect(result.snapshot[key]).toEqual({ error: "403" });
  });

  it("fails with 1 and writes nothing when the repository cannot be read", async () => {
    const result = await run("repo-fails");
    expect(result.exitCode).toBe(1);
    expect(result.files).toEqual([]);
  });

  it("never prints who starred or where visitors came from", async () => {
    for (const mode of ["ok", "one-403", "all-403"]) {
      const result = await run(mode);
      expect(result.output).not.toContain(LOGIN);
      expect(result.output).not.toContain(REFERRER);
      expect(result.output).not.toContain(PATH_SEEN);
      expect(JSON.stringify(result.snapshot)).not.toContain(LOGIN);
    }
  });
});
