import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { failureSite, scriptOutcome, selectBrowserScripts, serialBrowserScripts, shardScripts } from "./ci-browser-parallel.ts";

const pages = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("Browser failure sites", () => {
  it("returns no failure for PASS lines", () => {
    expect(failureSite("PASS scripts/ui-regression.ts\nPASS all checks")).toEqual({ site: null, message: null });
  });
  it("reads the first assertion frame after the error", () => {
    const log = `65 | assert(Date.now() < deadline, "input regression timed out");
                                    ^
AssertionError: input regression timed out
 generatedMessage: false,
      at /w/herdr-web-ui/herdr-web-ui/scripts/terminal-input-regression.ts:65:32
      at checkTerminalInput (/w/herdr-web-ui/herdr-web-ui/scripts/terminal-input-regression.ts:81:11)`;
    expect(failureSite(log)).toEqual({ site: "scripts/terminal-input-regression.ts:65", message: "AssertionError: input regression timed out" });
  });
  it("skips Playwright frames for the first script frame", () => {
    const log = `  TimeoutError: waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('.prompt-card') to be detached
      at /w/herdr-web-ui/herdr-web-ui/node_modules/playwright-core/lib/coreBundle.js:57694:13
      at checkSplitView (/w/herdr-web-ui/herdr-web-ui/scripts/split-view-regression.ts:509:13)`;
    expect(failureSite(log)).toEqual({ site: "scripts/split-view-regression.ts:509", message: "TimeoutError: waitFor: Timeout 30000ms exceeded." });
  });
  it("keeps an error with no script frame", () => {
    expect(failureSite("TypeError: broken\n  at /tmp/node_modules/scripts/helper.ts:2:1")).toEqual({ site: null, message: "TypeError: broken" });
  });
});

function indentedSection(source: string, parent: string, name: string, indent: number): string {
  const lines = source.split("\n");
  const parentLine = lines.indexOf(`${" ".repeat(indent - 2)}${parent}:`);
  if (parentLine < 0) throw new Error(`Missing ${parent} section`);
  const prefix = " ".repeat(indent);
  const start = lines.indexOf(`${prefix}${name}:`, parentLine + 1);
  if (start < 0) throw new Error(`Missing ${name} in ${parent}`);
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (new RegExp(`^${prefix}[^\\s#][^:]*:`).test(lines[end] ?? "")) break;
  }
  return lines.slice(start, end).join("\n");
}

const pageJob = (name: string): string => indentedSection(pages, "jobs", name, 2);
const ciJob = (name: string): string => indentedSection(ci, "jobs", name, 2);

describe("Pages deployment gate", () => {
  it("runs reusable CI only for a manual main dispatch, alongside the site build", () => {
    const validate = pageJob("validate");
    const build = pageJob("build");
    const deploy = pageJob("deploy");
    expect(validate).toContain("uses: ./.github/workflows/ci.yml");
    expect(validate).toContain("if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    expect(build).not.toContain("needs:");
    expect(deploy).toMatch(/needs:\s*\[validate, build, current\]/);
  });

  it("only runs on main, pins checkout to the triggering SHA, and serializes without canceling deployments", () => {
    expect(pages).toMatch(/workflow_dispatch:\n/);
    for (const name of ["validate", "build", "deploy"]) {
      expect(pageJob(name)).toContain("github.ref == 'refs/heads/main'");
    }
    expect(pages).toMatch(/^  group: pages$/m);
    expect(pages).toContain("cancel-in-progress: false");
    expect(ci).toMatch(/group: validation-/);
    expect(pageJob("validate")).toContain("permissions:\n      contents: read");
    for (const name of ["windows-install", "fast", "integration", "browser-main", "browser-other"]) {
      expect(ciJob(name)).toContain("ref: ${{ github.sha }}");
    }
  });

  for (const [name, pattern] of [
    ["CI workflow completion", /workflow_run:\n\s+workflows: \[CI\]/],
    ["completed runs only", /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/],
    ["main runs only", /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]\n\s+branches: \[main\]/],
  ] as const) {
    it(`triggers on ${name}`, () => {
      expect(pages).toMatch(pattern);
    });
  }

  it("does not trigger another Website run directly on push", () => {
    expect(pages).not.toMatch(/^  push:/m);
  });

  for (const job of ["build", "deploy"]) {
    for (const condition of [
      "github.event_name == 'workflow_dispatch' ||",
      "(github.event_name == 'workflow_run' &&",
      "github.event.workflow_run.conclusion == 'success' &&",
      "github.event.workflow_run.event == 'push' &&",
      "github.event.workflow_run.head_repository.full_name == github.repository))",
    ]) {
      it(`gates ${job} on ${condition}`, () => {
        expect(pageJob(job)).toContain(condition);
      });
    }
  }

  for (const condition of [
    "always() &&",
    "needs.build.result == 'success' &&",
    "(needs.validate.result == 'success' ||",
    "(needs.validate.result == 'skipped' &&",
    "github.event_name == 'workflow_run' &&\n      github.event.workflow_run.conclusion == 'success')) &&",
  ]) {
    it(`requires deployment dependency result ${condition}`, () => {
      expect(pageJob("deploy")).toContain(condition);
    });
  }

  for (const [job, field] of [
    ["build", "ref"],
    ["deploy", "EXPECTED_SHA"],
    ["deploy", "VALIDATED_SHA"],
    ["deploy", "DEPLOYED_SHA"],
  ]) {
    it(`uses the completed CI head SHA for ${field}`, () => {
      expect(pageJob(job)).toContain(`${field}: \${{ github.event.workflow_run.head_sha || github.sha }}`);
    });
  }

  it("records the checked-out commit rather than workflow_run's default-branch SHA", () => {
    expect(pageJob("build")).toContain('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');
  });

  it("fails closed on a current-main API error and refuses an outdated build before deployment", () => {
    const deploy = pageJob("deploy");
    expect(deploy).toContain("contents: read");
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
    expect(deploy).toContain("set -euo pipefail");
    expect(deploy).toContain('gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq \'.sha\'');
    expect(deploy).toContain('if [[ "$latest_sha" != "$EXPECTED_SHA" ]]');
    expect(deploy.indexOf("Verify deployment SHA is current")).toBeLessThan(deploy.indexOf("actions/deploy-pages@"));
  });

  it("skips the deploy job, not the run, when main moved on while it built", () => {
    type Job = { if?: string; needs?: string[]; environment?: unknown; permissions?: Record<string, string>; outputs?: Record<string, string>; "continue-on-error"?: unknown; steps?: { "continue-on-error"?: unknown }[] };
    const { jobs } = Bun.YAML.parse(pages) as { jobs: Record<string, Job> };
    const { current, deploy, build } = jobs as Record<"current" | "deploy" | "build", Job>;
    expect(current.environment).toBeUndefined();
    expect(current.permissions).toEqual({ contents: "read" });
    expect(current.needs).toEqual(["validate", "build"]);
    expect(current.outputs?.stale).toBe("${{ steps.current.outputs.stale }}");
    expect(deploy.needs).toEqual(["validate", "build", "current"]);
    expect(deploy.if).toContain("needs.current.result == 'success' && needs.current.outputs.stale == 'false'");
    expect(deploy.environment).toBeDefined();
    expect(current.if).toContain("needs.build.result == 'success'");
    expect(deploy.if).toContain("needs.build.result == 'success'");
    expect(build["continue-on-error"]).toBeUndefined();
    expect(build.steps?.some((step) => step["continue-on-error"] !== undefined)).toBe(false);
  });

  it("summarizes the validated, built, and deployed source SHAs", () => {
    const deploy = pageJob("deploy");
    expect(deploy).toContain("Validated SHA:");
    expect(deploy).toContain("Built SHA:");
    expect(deploy).toContain("Deployed SHA:");
    expect(deploy).toContain("${{ needs.build.outputs.sha }}");
  });

  it("keeps reports and nested verification evidence for CI jobs on success or failure", () => {
    expect(ciJob("fast")).toContain("CHECK_DIR: ${{ github.workspace }}/.ci");
    expect(ciJob("integration")).toContain("CHECK_DIR: ${{ github.workspace }}/.ci");
    const fast = ciJob("fast");
    expect(fast).toContain(".ci/report.json");
    expect(fast).toContain("if: always()");
    expect(fast).toContain(".ci/**/*.log");
    expect(fast).toContain(".ci/browser-evidence/**/*.png");
    expect(fast).toContain(".ci/browser-evidence/**/*.json");
    expect(fast).toContain(".ci/browser-evidence/**/*.zip");
    const integration = ciJob("integration");
    expect(integration).toContain(".ci/report.json");
    expect(integration).toContain("if: always()");
    expect(integration).toContain(".ci/**/*.log");
    expect(integration).toContain(".ci/config/herdr/sessions/*/test-server.log");
    const main = ciJob("browser-main");
    expect(main).toContain("if: always()");
    expect(main).toContain(".ci/browser-logs/**");
    expect(main).toContain(".ci/browser-evidence/**/*.png");
    expect(main).toContain(".ci/browser-evidence/**/*.json");
    expect(main).toContain(".ci/browser-evidence/**/*.zip");
  });

  it("keeps browser-other's logs on every outcome and its screenshots only when it failed or was cancelled", () => {
    const uploads = ciJob("browser-other").split(/^      - name: /m).filter((step) => step.includes("actions/upload-artifact@"));
    const onSuccess = uploads.find((step) => /^        if: success\(\)$/m.test(step));
    const otherwise = uploads.find((step) => /^        if: failure\(\) \|\| cancelled\(\)$/m.test(step));
    expect(uploads).toHaveLength(2);
    for (const step of [onSuccess, otherwise]) {
      expect(step).toContain(".ci/report.json");
      expect(step).toContain(".ci/browser-logs/**");
    }
    expect(onSuccess).not.toContain(".ci/browser-evidence/");
    expect(otherwise).toContain(".ci/browser-evidence/**/*.png");
    expect(otherwise).toContain(".ci/browser-evidence/**/*.json");
    expect(otherwise).toContain(".ci/browser-evidence/**/*.zip");
  });
});

describe("Browser lane script lists", () => {
  const serial = serialBrowserScripts();
  const env = (job: string, name: string) => job.match(new RegExp(`^\\s+${name}: (.+)$`, "m"))?.[1];

  it("reads every script the serial lane runs, and only those", () => {
    const sh = readFileSync(new URL("./ci-browser.sh", import.meta.url), "utf8");
    const runs = [...sh.matchAll(/^run_script (\S+)/gm)].map((match) => match[1]).filter((script) => script !== "scripts/demo-build.ts");
    expect(serial).toEqual(runs);
    expect(serial).toContain("scripts/ui-regression.ts");
    expect(serial).toContain("scripts/ui-contexts-regression.ts");
    expect(serial).toContain("scripts/ui-contexts-layout-regression.ts");
    expect(serial).toContain("scripts/sidebar-spacing-demo-regression.ts");
    expect(new Set(serial).size).toBe(serial.length);
  });

  it("splits the serial lane across the CI browser jobs with nothing dropped or run twice", () => {
    const shards = ["browser-main", "browser-other"].map((name) => {
      const job = ciJob(name);
      expect(job).toContain("run: bun run check run -- bun scripts/ci-browser-parallel.ts");
      return selectBrowserScripts(serial, env(job, "BROWSER_SCRIPTS"), env(job, "BROWSER_EXCLUDE"));
    });
    const all = shards.flat();
    expect(all.length).toBe(serial.length);
    expect([...all].sort()).toEqual([...serial].sort());
  });

  it("runs each of browser-other's scripts in exactly one of its parts, for every number of parts its matrix gives", () => {
    const job = ciJob("browser-other");
    const selected = selectBrowserScripts(serial, env(job, "BROWSER_SCRIPTS"), env(job, "BROWSER_EXCLUDE"));
    const timings = JSON.parse(readFileSync(new URL("./ci-browser-timings.json", import.meta.url), "utf8")) as Record<string, number>;
    const sizes = [...env(job, "shard")!.matchAll(/'\[([\d,]*)\]'/g)].map((match) => match[1]!.split(",").map(Number));
    expect(sizes.map((list) => list.length).sort()).toEqual([3, 4, 5]);
    for (const list of sizes) {
      expect(list).toEqual(list.map((_, index) => index + 1));
      const parts = list.map((part) => shardScripts(selected, timings, `${part}/${list.length}`));
      const times = new Map<string, number>();
      for (const script of parts.flat()) times.set(script, (times.get(script) ?? 0) + 1);
      expect(selected.filter((script) => times.get(script) !== 1), `${list.length} parts: in no part or in two`).toEqual([]);
      expect(parts.flat().length).toBe(selected.length);
      for (const part of parts) expect(part.length).toBeGreaterThan(0);
    }
  });

  it("runs every herdr-backed lane under a shared check slot that it waits for", () => {
    expect(ciJob("integration")).toContain("run: bun run check integration");
    for (const name of ["integration", "browser-main", "browser-other"]) {
      const job = ciJob(name);
      expect(env(job, "CHECK_MAX_RUNS")).toMatch(/^[1-8]$/);
      const wait = Number(env(job, "CHECK_WAIT_SECONDS"));
      const timeout = Number(job.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
      expect(wait).toBeGreaterThan(0);
      expect(timeout * 60).toBeGreaterThanOrEqual(wait + 600);
    }
  });

  it("calls a script that passed only on its second run flaky, and one that failed again a failure", () => {
    expect(scriptOutcome(0, false)).toBe("pass");
    expect(scriptOutcome(0, true)).toBe("flaky");
    expect(scriptOutcome(1, true)).toBe("fail");
    expect(scriptOutcome(1, false)).toBe("fail");
  });

  it("refuses a script name the serial lane does not run", () => {
    expect(() => selectBrowserScripts(serial, "scripts/missing-regression.ts")).toThrow("scripts/missing-regression.ts");
    expect(() => selectBrowserScripts(serial, undefined, "scripts/missing-regression.ts")).toThrow("scripts/missing-regression.ts");
    expect(selectBrowserScripts(serial, undefined, "scripts/ui-regression.ts")).toEqual(serial.filter((script) => script !== "scripts/ui-regression.ts"));
  });

  it("runs both isolated UI flows in browser-main and keeps the local UI command complete", () => {
    const main = ciJob("browser-main");
    expect(selectBrowserScripts(serial, env(main, "BROWSER_SCRIPTS"))).toEqual([
      "scripts/ui-regression.ts", "scripts/ui-terminal-regression.ts", "scripts/ui-ime-regression.ts", "scripts/ui-access-regression.ts", "scripts/ui-contexts-regression.ts", "scripts/ui-contexts-layout-regression.ts",
    ]);
    expect(env(main, "BROWSER_WORKERS")).toBe("2");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const script of ["ui-regression.ts", "ui-terminal-regression.ts", "ui-ime-regression.ts", "ui-access-regression.ts", "ui-contexts-regression.ts", "ui-contexts-layout-regression.ts", "sticky-modifiers-regression.ts"]) {
      expect(pkg.scripts["test:ui"]).toContain(`bun scripts/${script}`);
    }
  });

  it("uses existing isolated worker controls without increasing hosted integration concurrency", () => {
    expect(env(ciJob("integration"), "HERDR_TEST_SHARDS"))
      .toBe("${{ runner.environment == 'self-hosted' && '4' || '1' }}");
    expect(env(ciJob("browser-other"), "BROWSER_WORKERS"))
      .toBe("${{ runner.environment == 'self-hosted' && '6' || '3' }}");
    expect(env(ciJob("browser-other"), "BROWSER_SHARD")).toBe("${{ matrix.shard }}/${{ strategy.job-total }}");
  });
});

describe("Extracted UI checks", () => {
  it("refuses a direct mobile viewport run in unit mode instead of silently passing", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./mobile-viewport-regression.ts", import.meta.url))], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, HERDR_TEST_MODE: "unit" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HERDR_TEST_MODE=unit");
  });

  const moved = [
    "checkSplitView", "checkBackgroundTabKeepsTerminalSize",
    "checkPushSettings", "checkWakeLock", "checkSecretInput", "checkTerminalCopy", "checkPaneFind",
    "checkUsageMeters", "checkNotificationStartup", "checkNotificationView", "checkMobileViewport",
    "checkTerminalPinch", "checkMobileTabs", "checkTabMenu", "checkDefaultView",
    "checkComposerReconnect", "checkDroplet", "checkTakeOver", "checkAlertSound",
    "checkChatKeepsTerminalSize", "checkPaneSwitchKeepsTerminalSize", "checkFocusedWindowReclaimsTerminalSize",
    "checkUpdateNotice", "checkTelemetrySettings",
  ];
  const calls = (source: string) => [...source.matchAll(/\b(check[A-Z]\w*)\(/g)].map((match) => match[1]!);

  it("moves all 24 existing checks exactly once, in order, without removing core input checks", () => {
    const core = calls(readFileSync(new URL("./ui-regression.ts", import.meta.url), "utf8"));
    const contexts = calls(readFileSync(new URL("./ui-contexts-checks.ts", import.meta.url), "utf8"));
    expect(contexts.filter((name) => moved.includes(name))).toEqual(moved);
    expect(core.filter((name) => moved.includes(name))).toEqual([]);
    for (const name of ["checkTerminalInput", "checkSafariIme", "checkHeldDraftPaneSwitch",
      "checkCommandBackspace", "checkCtrlEnter", "checkCommandArrows"]) {
      expect(core.filter((call) => call === name)).toHaveLength(1);
    }
  });

  for (const [script, mode] of ["ui-contexts-regression.ts", "ui-contexts-layout-regression.ts", "ui-terminal-regression.ts", "ui-ime-regression.ts", "ui-access-regression.ts"].flatMap((script) => (["unit", "live"] as const).map((mode) => [script, mode] as const))) {
    it(`${script} refuses ${mode} execution before touching a herdr daemon`, () => {
      const root = mkdtempSync(join(tmpdir(), "ui-context-guard-"));
      try {
        const invoked = join(root, "invoked");
        const herdr = join(root, "herdr");
        writeFileSync(herdr, '#!/bin/sh\nprintf called > "$HERDR_GUARD_LOG"\nexit 1\n', { mode: 0o700 });
        const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./${script}`, import.meta.url))], {
          encoding: "utf8", timeout: 5_000,
          env: {
            ...process.env, TMPDIR: root, XDG_CONFIG_HOME: root,
            OVIS_HERDR_BIN: herdr, HERDR_GUARD_LOG: invoked,
            HERDR_SOCKET: join(root, "no-parent.sock"),
            HERDR_TEST_MODE: mode === "unit" ? "unit" : "integration",
            HERDR_TEST_LIVE: mode === "live" ? "1" : "",
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr.toLowerCase()).toContain(mode);
        expect(existsSync(invoked)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

const guardShell = (job: string): string => {
  const guard = pageJob(job).match(/        run: \|\n([\s\S]*?)(?=\n      -|\n  [a-z-]+:|$)/)?.[1]
    ?.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  if (!guard) throw new Error(`Missing SHA guard shell in ${job}`);
  return guard;
};

describe.skipIf(process.platform === "win32")("Pages SHA guard execution", () => {
  const sha = "a".repeat(40);
  const newer = "b".repeat(40);

  for (const scenario of [
    { job: "current", name: "current: passes the validated build at main's head", built: sha, latest: sha, api: "0", code: 0, stale: "false" },
    { job: "current", name: "current: ends a run main has moved past without failing it, with a notice that promises nothing", built: sha, latest: newer, api: "0", code: 0, stale: "true" },
    { job: "current", name: "current: rejects an artifact from another commit", built: newer, latest: sha, api: "0", code: 1, stale: null },
    { job: "current", name: "current: fails closed when GitHub denies the lookup", built: sha, latest: sha, api: "1", code: 1, stale: null },
    { job: "current", name: "current: rejects a malformed API response", built: sha, latest: "null", api: "0", code: 1, stale: null },
    { job: "deploy", name: "deploy: accepts the validated build at current main", built: sha, latest: sha, api: "0", code: 0, stale: null },
    { job: "deploy", name: "deploy: refuses a commit main moved past after the current job", built: sha, latest: newer, api: "0", code: 1, stale: null },
    { job: "deploy", name: "deploy: rejects an artifact from another commit", built: newer, latest: sha, api: "0", code: 1, stale: null },
    { job: "deploy", name: "deploy: fails closed when GitHub denies the lookup", built: sha, latest: sha, api: "1", code: 1, stale: null },
  ]) {
    it(scenario.name, () => {
      const guard = guardShell(scenario.job);
      const root = mkdtempSync(join(tmpdir(), "pages-guard-"));
      try {
        writeFileSync(join(root, "gh"), '#!/usr/bin/env bash\nif [[ "$CASE_API" != 0 ]]; then exit "$CASE_API"; fi\nprintf "%s\\n" "$CASE_LATEST"\n', { mode: 0o700 });
        const output = join(root, "github-output");
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-c", guard], {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            PATH: `${root}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "fixture/repository",
            EXPECTED_SHA: sha,
            BUILT_SHA: scenario.built,
            CASE_API: scenario.api,
            CASE_LATEST: scenario.latest,
            GITHUB_OUTPUT: output,
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(scenario.code);
        const written = readFileSync(output, "utf8").match(/^stale=(.*)$/m)?.[1] ?? null;
        expect(written).toBe(scenario.stale);
        const notice = result.stdout.split("\n").find((line) => line.startsWith("::notice title=Deployment skipped::"));
        expect(notice !== undefined).toBe(scenario.stale === "true");
        if (notice) expect(notice).toBe(`::notice title=Deployment skipped::This run built ${sha}, and main is now ${newer}, so it deploys nothing.`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
