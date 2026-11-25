import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import { fixedSleepCounts, fixedSleeps, markedWaitCounts, markedWaits, sleepFiles } from "./fixed-sleeps.ts";
import { fail, files, lineOf, read, repo, stripComments } from "./source-scan.ts";

const SOURCES = [...files("{src,server,shared,scripts,site,telemetry,integrations,tui}/**/*.{ts,tsx,mjs,js}"), "vite.config.ts"];

// A declaration never runs on into the next `import`: one that no semicolon ends would otherwise take the import
// after it for its own `from`, and that import's specifier would go unread.
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:(?!\bimport\b)[^;])*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

const specifiersIn = (code: string): { specifier: string; line: number }[] =>
  [...code.matchAll(SPECIFIER)].map((match) => {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    return { specifier, line: lineOf(code, match.index + match[0].lastIndexOf(specifier)) };
  });

const specifiers = (file: string): { specifier: string; at: string }[] =>
  specifiersIn(stripComments(read(file))).map(({ specifier, line }) => ({ specifier, at: `${file}:${line}: ${specifier}` }));

describe("imports", () => {
  it("name relative modules with their extension and never use the @shared alias", () => {
    const offenders = SOURCES.flatMap((file) => specifiers(file)
      .filter(({ specifier }) => specifier.startsWith("@shared/") || (specifier.startsWith(".") && !/\.(?:ts|tsx|mjs|js|css|json|md|svg|png|woff2|html|txt|wasm|sh)(?:\?[\w&=-]*)?$/.test(specifier)))
      .map(({ at }) => at));
    fail(offenders, "Imports carry explicit .ts/.tsx extensions and relative paths (AGENTS.md, Code conventions): write \"./x.ts\" or \"../shared/x.ts\", never \"./x\" or \"@shared/x\".");
  });

  it("finds the specifiers and the line each is on", () => {
    expect(specifiersIn("import { a } from \"./a.ts\";\nimport type {\n  B,\n} from '../b';\nimport \"./side.css\";\nconst c = await import(\"./c.tsx\");\nexport * from \"./d.ts\";"))
      .toEqual([{ specifier: "./a.ts", line: 1 }, { specifier: "../b", line: 4 }, { specifier: "./side.css", line: 5 }, { specifier: "./c.tsx", line: 6 }, { specifier: "./d.ts", line: 7 }]);
  });
});

describe("the frontend build", () => {
  const BUILD_SCRIPTS = ["vite.config.ts", "scripts/build-xterm.ts", "scripts/compressed-assets.ts", "scripts/service-worker-build.ts", "scripts/theme-bootstrap-build.ts", "scripts/shell-build.ts", "scripts/build-cache.ts"];

  it("imports nothing from server/ or relay/", () => {
    const offenders = BUILD_SCRIPTS.flatMap((file) => specifiers(file).filter(({ specifier }) => /(?:^|\/)(?:server|relay)\//.test(specifier)).map(({ at }) => at));
    fail(offenders, "The frontend build scripts import nothing from server/ or relay/ (they would load the server's environment): put what both need in shared/ (shared/web-policy.ts) and import it from there.");
  });
});

describe("what the browser loads", () => {
  // src/ and site/ are bundled for the browser, and shared/ is loaded there and by the server both.
  // An import that leads out of them (server/, relay/, scripts/, app/ …) puts code written for Bun
  // or Node into that bundle, where the environment it reads is not there.
  const MAY_IMPORT: Readonly<Record<string, readonly string[]>> = { src: ["shared"], site: ["src", "shared"], shared: [] };
  const leadsTo = (file: string, specifier: string): string => posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\/.*$/, "");
  const crossings = Object.keys(MAY_IMPORT).flatMap((own) =>
    files(`${own}/**/*.{ts,tsx,mjs,js}`).filter((file) => !/\.test\./.test(file)).flatMap((file) =>
      specifiers(file).filter(({ specifier }) => specifier.startsWith(".")).map(({ specifier, at }) => ({ own, to: leadsTo(file, specifier), at })))
      .filter(({ to }) => to !== own));

  it("imports only from its own directory and the ones it may", () => {
    fail(crossings.filter(({ own, to }) => !MAY_IMPORT[own]?.includes(to)).map(({ at }) => at),
      "Code the browser loads imports only from the browser's side: src/ from src/ and shared/, site/ from site/, src/ and shared/, and shared/ from shared/ alone, since the server loads it too. Move what both sides need into shared/ (as shared/web-policy.ts and shared/markdown.ts were) and import it from there; a type that describes the wire goes in shared/protocol.ts.");
  });

  it("lists no import that nothing makes any more", () => {
    const made = new Set(crossings.map(({ own, to }) => `${own}/ from ${to}/`));
    fail(Object.entries(MAY_IMPORT).flatMap(([own, others]) => others.map((to) => `${own}/ from ${to}/`)).filter((allowed) => !made.has(allowed)),
      "MAY_IMPORT in scripts/conventions.test.ts allows these imports, and no code makes them any more: take them out.");
  });

  it("knows the directory an import leads to", () => {
    expect(leadsTo("src/lib/api.ts", "../../shared/protocol.ts")).toBe("shared");
    expect(leadsTo("src/lib/api.ts", "../../server/http.ts")).toBe("server");
    expect(leadsTo("src/server/list.ts", "./server/row.ts")).toBe("src");
    expect(leadsTo("site/demo/transport.ts", "../../src/lib/phone.ts")).toBe("src");
    expect(leadsTo("shared/web-policy.ts", "../package.json")).toBe("package.json");
  });
});

const gitIn = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function ratchetBase(env: Record<string, string | undefined> = process.env, cwd: string = repo): string | null {
  const named = env["RATCHET_BASE"];
  if (named) {
    if (gitIn(cwd, "cat-file", "-e", `${named}^{commit}`).status !== 0) throw new Error(`RATCHET_BASE ${named} is not in this checkout: fetch it first, as ci.yml's Fast checks does.`);
    return named;
  }
  const base = gitIn(cwd, "merge-base", "HEAD", "origin/main");
  if (base.status === 0) return base.stdout.trim();
  if (env["CI"]) console.log("No base for the ratchets here (no RATCHET_BASE, no origin/main): they compare with nothing.");
  return null;
}

const renamesSince = (base: string): Map<string, string> =>
  new Map(gitIn(repo, "diff", "--name-status", "-M", "--diff-filter=R", base).stdout.split("\n")
    .map((line) => line.split("\t")).filter((parts) => parts.length === 3).map(([, from, to]) => [to!, from!]));

const atBase = (base: string, file: string): string | null => {
  const shown = gitIn(repo, "show", `${base}:${file}`);
  return shown.status === 0 ? shown.stdout : null;
};

describe("the ratchets' base", () => {
  it("is the commit CI names, fails when that commit is not in the checkout, and is else where the branch left origin/main", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-ratchet-base-"));
    try {
      const git = (...args: string[]) => gitIn(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args);
      git("init", "-q", "-b", "work");
      git("commit", "-q", "--allow-empty", "-m", "base");
      const first = git("rev-parse", "HEAD").stdout.trim();
      expect(ratchetBase({}, root)).toBeNull();
      git("update-ref", "refs/remotes/origin/main", first);
      git("commit", "-q", "--allow-empty", "-m", "change");
      expect(ratchetBase({}, root)).toBe(first);
      expect(ratchetBase({ RATCHET_BASE: first }, root)).toBe(first);
      expect(() => ratchetBase({ RATCHET_BASE: `${"0".repeat(39)}1` }, root)).toThrow("is not in this checkout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Holds every file to its count in `json`, which may only shrink: never above the one at the ratchets' base, and
 * lowered when the code has fewer. `instead` says what to do in place of raising it.
 */
function countRatchet({ json, what, counts, list, print, instead }: {
  json: string; what: string; counts: () => Record<string, number>; list: (file: string) => string[]; print: string; instead: string;
}): void {
  const baseline = JSON.parse(read(json)) as Record<string, number>;

  const committed = (): { counts: Record<string, number>; renames: Map<string, string> } | null => {
    const base = ratchetBase();
    const text = base === null ? null : atBase(base, json);
    return base === null || text === null ? null : { counts: JSON.parse(text) as Record<string, number>, renames: renamesSince(base) };
  };

  it(`never raises ${json} above the one at the ratchets' base`, () => {
    const at = committed();
    if (at === null) return;
    const before = at.counts;
    const was = (file: string): number => before[file] ?? before[at.renames.get(file) ?? ""] ?? 0;
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);
    fail([
      ...Object.entries(baseline).filter(([file, count]) => count > was(file)).map(([file, count]) => `${file}: ${count}, the base has ${was(file)}`),
      ...total(baseline) > total(before) ? [`total: ${total(baseline)}, the base has ${total(before)}`] : [],
    ], `${json} may only shrink: ${instead} A renamed file takes its entry along with the same count, which keeps the total.`);
  });

  it(`adds no ${what} and lowers the baseline when one goes`, () => {
    const now = counts();
    const grown = Object.entries(now).filter(([file, count]) => count > (baseline[file] ?? 0));
    fail(grown.flatMap(([file, count]) => [`${file}: ${count} ${what}s, baseline ${baseline[file] ?? 0}`, ...list(file).map((line) => `  ${line}`)]),
      `${instead} Never raise ${json}; when a file was renamed, move its entry to the new path with the same count.`);
    const shrunk = Object.entries(baseline).filter(([file, count]) => (now[file] ?? 0) < count);
    fail(shrunk.map(([file, count]) => `${file}: ${now[file] ?? 0} now, baseline ${count}`),
      `These ${what}s went away: lower their entries in ${json} to the counts shown (remove an entry at 0; \`${print}\` prints them all), so they cannot come back.`);
  });

  it("lists only files that exist", () => {
    fail(Object.keys(baseline).filter((file) => !existsSync(join(repo, file)) || !sleepFiles().includes(file)),
      `Remove these entries from ${json}: the files are gone or no longer covered. A renamed file keeps its entry under the new path, with the same count.`);
  });
}

const WAIT_FOR_THE_CONDITION = "Wait for the condition, not for a set time (AGENTS.md: bounded polls and deadlines, never fixed sleeps): poll in a loop bounded by a deadline (`const deadline = Date.now() + 10_000; while (!done()) { if (Date.now() > deadline) throw new Error(\"…\"); await Bun.sleep(25); }`), or race a timeout against the event (`Promise.race`).";

describe("fixed sleeps", () => {
  countRatchet({
    json: "scripts/fixed-sleeps.json", what: "fixed sleep", counts: fixedSleepCounts, list: fixedSleeps, print: "bun scripts/fixed-sleeps.ts",
    instead: `${WAIT_FOR_THE_CONDITION} A wait that must be fixed (proving that nothing arrives, a settle gap herdr needs) says so with \`// fixed wait: <why>\` on its line or the line above, and counts in scripts/fixed-waits.json instead.`,
  });

  it("tells a fixed sleep from a bounded poll", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("await Bun.sleep(300);")).toBe(1);
    expect(found("await page.waitForTimeout(500);")).toBe(1);
    expect(found("// fixed wait: nothing may arrive in this time\nawait page.waitForTimeout(500);")).toBe(0);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 1500));")).toBe(1);
    expect(found("while (!ready) await Bun.sleep(20);")).toBe(1);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 0));")).toBe(0);
    expect(found("while (!done() && Date.now() < deadline) await Bun.sleep(25);")).toBe(0);
    expect(found("for (let i = 0; i < 40 && !seen(); i++) await Bun.sleep(50);")).toBe(0);
    expect(found("const deadline = Date.now() + 5000;\nwhile (!await check()) {\n  assert.ok(Date.now() < deadline, \"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("for (;;) {\n  if (seen()) break;\n  if (Date.now() > deadline) throw new Error(\"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("await Promise.race([event, Bun.sleep(1000)]);")).toBe(0);
    expect(found("// fixed wait: nothing may arrive in this time\nawait Bun.sleep(NO_SEND_WAIT_MS);")).toBe(0);
    expect(found("async function f() {\n  while (Date.now() < deadline) {\n    const g = async () => { await Bun.sleep(5); };\n  }\n}")).toBe(1);
    expect(found("await Bun.sleep(1000); // fixed wait:")).toBe(1);
    expect(found("for (let i = 0; i < panes.length; i++) { await Bun.sleep(1000); }")).toBe(1);
    expect(found("for (let attempt = 0; attempt < MAX_TRIES && !seen(); attempt++) await Bun.sleep(50);")).toBe(0);
    expect(found("await new Promise((r) => setTimeout(() => r(), 500));")).toBe(1);
    expect(found("await new Promise(function (r) { setTimeout(r, 500); });")).toBe(1);
  });

  it("counts each call of a sleep helper, not its definition", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(10);\nawait sleep(20);")).toBe(2);
    expect(found("function delay(ms) { return Bun.sleep(ms); }\nawait delay(300);")).toBe(1);
    expect(found("const wait = (ms: number) => page.waitForTimeout(ms);\nawait wait(10);\nawait wait(20);")).toBe(2);
    expect(found("import { setTimeout as sleep } from \"node:timers/promises\";\nawait sleep(500);")).toBe(1);
    expect(found("const wait = io.wait ?? Bun.sleep;\nawait wait(5);")).toBe(1);
    expect(found("const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));\nawait tick();\nawait tick(20);")).toBe(1);
    expect(found("const wait = io.wait ?? Bun.sleep;\nwhile (Date.now() < deadline) await wait(25);")).toBe(0);
    expect(found("async function flood() {\n  await Bun.sleep(150);\n  send();\n}\nawait flood();\nawait flood();")).toBe(1);
  });
});

/**
 * Finding or ending processes by name (pkill, killall, pgrep -f) reaches every process on the PC, the user's own session
 * and test app included: a lane once ended the maintainer's test app with `pkill -f server/index.ts`. The name must hold
 * something the run made (a mkdtemp directory, a randomUUID tag, its own pid), not a fixed string or an id herdr gave
 * out, which another session's pane has too.
 */
const KILLS_BY_NAME = /\b(pkill|killall|pgrep)\b/g;
/** They run these commands only inside a container they start. */
const IN_A_CONTAINER = ["scripts/fresh-install-docker.ts", "scripts/join/join.contract.test.ts"];

/** One argument of the command, quoted or bare, or what ends the command (`]`, `)`, `;`, `||`, a redirection …). */
const ARGUMENT = /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\|\||&&|[)\];|<>]|(?:\$\{[^}]*\}|[^\s"'`,[\]();|&<>])+(?:\([^()]*\))?/g;
const unquoted = (argument: string): string => argument.replace(/^["'`]|["'`]$/g, "");

/** What an argument takes from the run: the values it interpolates, or a whole JavaScript expression. None for a fixed string. */
function namesIn(argument: string, shell: boolean): string[] {
  if (shell || argument.startsWith("`")) return [...argument.matchAll(/\$\{([^}]+)\}|\$([A-Za-z_]\w*)/g)].map((match) => match[1] ?? match[2]!);
  return /^["']/.test(argument) ? [] : [argument];
}

/**
 * The lines that find or end processes by a name the run did not make (`pgrep` only with `-f`). The name is the command's
 * last argument that is no option (`-f`, `-KILL`, `-${signal}`); a command scoped to a parent the run names
 * (`pgrep -P <pid>`) passes too.
 */
function killsByName(file: string, text: string): string[] {
  const code = file.endsWith(".sh") ? text.replace(/(^|\s)#.*$/gm, "$1") : stripComments(text);
  return [...code.matchAll(KILLS_BY_NAME)].flatMap(({ index: at, 1: command }) => {
    const after = code.slice(at + command!.length);
    // `["pkill", "-f", tag]` is an argument list, which may go on over lines; anything else (a .sh line, a command in a
    // string) is a shell's, which ends with its line
    const list = /["']$/.test(code.slice(0, at)) && /^["']/.test(after);
    const shell = !list;
    const args: string[] = [];
    for (const [token] of (list ? after.slice(1) : after.slice(0, (after + "\n").indexOf("\n"))).matchAll(ARGUMENT)) {
      if (/^(?:\|\||&&|[)\];|<>])$/.test(token)) {
        if (token === ">" && /^\d$/.test(args.at(-1) ?? "")) args.pop();
        break;
      }
      args.push(token);
    }
    if (command === "pgrep" && !args.some((arg) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(unquoted(arg)))) return [];
    const scoped = args.some((arg, i) => unquoted(arg) === "-P" && namesIn(args[i + 1] ?? "", shell).length > 0);
    const names = namesIn(args.filter((arg) => !unquoted(arg).startsWith("-")).at(-1) ?? "", shell);
    if (scoped || (names.length > 0 && !names.some((name) => /terminal|pane/i.test(name)))) return [];
    const line = lineOf(code, at);
    return [`${file}:${line}: ${text.split("\n")[line - 1]!.trim()}`];
  }).filter((offender, at, all) => all.indexOf(offender) === at);
}

describe("killing by name", () => {
  const KILL_FILES = files("{server,src,shared,scripts,site,telemetry,integrations,tui,app}/**/*.{ts,tsx,mjs,js,sh}")
    .filter((file) => file !== "scripts/conventions.test.ts");

  it("names only what the run made", () => {
    fail(KILL_FILES.filter((file) => !IN_A_CONTAINER.includes(file)).flatMap((file) => killsByName(file, read(file))),
      "pkill, killall and pgrep -f reach every process on the PC, the user's own session and test app included. Name what this run made: a mkdtemp directory or a randomUUID tag in the command line (`pgrep -f ${tag}`), or the pids it started (scripts/own-processes.ts: `ownProcesses(/terminal attach t1$/)` lists the matching processes under this one). A herdr terminal or pane id is no such name: another session has the same ids.");
  });

  it("lists only files that still kill by name inside their container", () => {
    fail(IN_A_CONTAINER.filter((file) => !existsSync(join(repo, file)) || killsByName(file, read(file)).length === 0),
      "IN_A_CONTAINER in scripts/conventions.test.ts lets these files kill by name, and they no longer do: take them out.");
  });

  it("tells a name the run made from one any process can have", () => {
    const found = (code: string, file = "example.ts") => killsByName(file, code).length;
    expect(found("Bun.spawnSync([\"pkill\", \"-f\", \"server/index.ts\"]);")).toBe(1);
    expect(found("pkill -f server/index.ts", "example.sh")).toBe(1);
    expect(found("killall bun", "example.sh")).toBe(1);
    expect(found("Bun.spawn([\"pkill\", \"-f\", `^[^ ]*herdr terminal attach ${terminal}$`]);")).toBe(1);
    expect(found("Bun.spawnSync([\"pgrep\", \"-f\", `terminal session observe ${paneId}`]);")).toBe(1);
    expect(found("Bun.spawn([\"pkill\", `-${name}`, \"-f\", \"server/index.ts\"]);")).toBe(1);
    expect(found("pkill -f \"server/index.ts\" 2>/dev/null || true", "example.sh")).toBe(1);
    expect(found("await m.sh(`pkill -f ${tag}-x; pkill -f server/index.ts`);")).toBe(1);
    expect(found("Bun.spawn([\"pkill\", `-${name}`, \"-f\", s.log]);")).toBe(0);
    expect(found("Bun.spawnSync([\"sudo\", \"-n\", \"pkill\", \"-u\", username]);")).toBe(0);
    expect(found("Bun.spawnSync([\n  \"pgrep\",\n  \"-f\",\n  \"server/index.ts\",\n]);")).toBe(1);
    expect(found("Bun.spawnSync([\n  \"pkill\",\n  \"-f\",\n  tag,\n]);")).toBe(0);
    expect(found("Bun.spawnSync([\"pgrep\", \"-f\", tag]);")).toBe(0);
    expect(found("spawnSync(\"pkill\", [\"-KILL\", \"-f\", tempDir]);")).toBe(0);
    expect(found("pkill -f \"$r/remote.sh\" || true", "example.sh")).toBe(0);
    expect(found("Bun.spawnSync([\"pgrep\", \"-P\", String(process.pid), \"-f\", \"pty-host.mjs\"]);")).toBe(0);
    expect(found("kill -HUP \"$(pgrep -o -x sshd)\"", "example.sh")).toBe(0);
    expect(found("# pkill -f server/index.ts", "example.sh")).toBe(0);
    expect(found("// pkill -f server/index.ts")).toBe(0);
  });
});

describe("waits marked fixed", () => {
  countRatchet({
    json: "scripts/fixed-waits.json", what: "marked fixed wait", counts: markedWaitCounts, list: markedWaits, print: "bun scripts/fixed-sleeps.ts --marked",
    instead: `A \`// fixed wait:\` takes a wait out of scripts/fixed-sleeps.json, not out of this count. ${WAIT_FOR_THE_CONDITION} To keep a new wait that must be fixed, take out one that no longer has to be.`,
  });

  it("counts the set-time waits a marker excuses, and nothing else", () => {
    const found = (code: string) => markedWaits("example.ts", code).length;
    expect(found("// fixed wait: nothing may arrive in this time\nawait page.waitForTimeout(500);")).toBe(1);
    expect(found("await Bun.sleep(300); // fixed wait: a settle gap herdr needs")).toBe(1);
    expect(found("await Bun.sleep(300);")).toBe(0);
    expect(found("// fixed wait: polled\nwhile (!done() && Date.now() < deadline) await Bun.sleep(25);")).toBe(0);
    expect(found("// fixed wait: raced\nawait Promise.race([event, Bun.sleep(1000)]);")).toBe(0);
  });
});

describe("the tools typecheck", () => {
  const ROOTS = ["scripts", "integrations", "site", "app/scripts"];
  /** The tracked .ts/.tsx files under the roots of the checkout at `cwd` that are hidden or in a hidden folder; `-z`, since git quotes a name with non-ASCII bytes. */
  const hiddenSources = (cwd: string): string[] =>
    gitIn(cwd, "ls-files", "-z", ...ROOTS).stdout.split("\0").filter((file) => /\.tsx?$/.test(file) && /(^|\/)\./.test(file));
  const config = JSON.parse(read("tsconfig.tools.json")) as { extends?: unknown; include?: unknown; exclude?: unknown; files?: unknown; compilerOptions?: unknown };
  const excluded = (json: string): string[] | null => {
    const list = (JSON.parse(json) as { exclude?: unknown }).exclude;
    return Array.isArray(list) ? list as string[] : null;
  };
  const added = (now: readonly string[], before: readonly string[], renames: ReadonlyMap<string, string>): string[] =>
    now.filter((file) => !before.includes(file) && !before.includes(renames.get(file) ?? ""));
  /**
   * The exclude entries that take out a file the base checked: those its exclude list lacks but a renamed file's. Null
   * when the base has no exclude list: every base since main went green with the list (dad4ce663) has one, and the
   * file list before it cannot say what the folder include checks now.
   */
  const uncheckedNow = (now: readonly string[], baseJson: string, renames: ReadonlyMap<string, string>): string[] | null => {
    const base = JSON.parse(baseJson) as { exclude?: unknown };
    return Array.isArray(base.exclude) ? added(now, base.exclude as string[], renames) : null;
  };
  const now = excluded(read("tsconfig.tools.json")) ?? [];

  it("excludes no more files than at the ratchets' base", () => {
    const base = ratchetBase();
    if (base === null) return;
    const json = atBase(base, "tsconfig.tools.json");
    const offenders = json === null ? null : uncheckedNow(now, json, renamesSince(base));
    if (offenders === null) throw new Error(`tsconfig.tools.json at ${base} has no exclude list to compare with: keep the list in it, empty when every file is fixed.`);
    fail(offenders, "The exclude list of tsconfig.tools.json may only shrink: fix the type errors `bun run typecheck` reports in these files instead of excluding them. A renamed file (renamed with `git mv`, or with the rename staged, so git sees it) takes its entry along under the new path.");
  });

  it("compares only with a base's exclude list: a base with the old file list has none, and fails", () => {
    expect(uncheckedNow(["scripts/c.ts"], JSON.stringify({ exclude: [] }), new Map())).toEqual(["scripts/c.ts"]);
    expect(uncheckedNow([], JSON.stringify({ files: ["scripts/a.ts"] }), new Map())).toBeNull();
  });

  it("tells a new entry from a renamed file's, whatever the list's length", () => {
    const renames = new Map([["scripts/renamed.ts", "scripts/b.ts"], ["scripts/moved.ts", "scripts/never-excluded.ts"]]);
    expect(added(["scripts/a.ts", "scripts/new.ts"], ["scripts/a.ts"], renames)).toEqual(["scripts/new.ts"]);
    expect(added(["scripts/a.ts", "scripts/new.ts"], ["scripts/a.ts", "scripts/b.ts"], renames)).toEqual(["scripts/new.ts"]);
    expect(added(["scripts/a.ts", "scripts/renamed.ts"], ["scripts/a.ts", "scripts/b.ts"], renames)).toEqual([]);
    expect(added(["scripts/a.ts", "scripts/moved.ts"], ["scripts/a.ts", "scripts/b.ts"], renames)).toEqual(["scripts/moved.ts"]);
    expect(added(["scripts/a.ts"], ["scripts/a.ts", "scripts/b.ts"], renames)).toEqual([]);
  });

  it("checks every root, with nothing beside the exclude list taking a file out", () => {
    expect(config.include, `tsconfig.tools.json checks the folders ${ROOTS.join(", ")} whole: keep them all in "include".`).toEqual(ROOTS);
    expect(config.files, "tsconfig.tools.json names no files: a file under its roots is checked without being listed.").toBeUndefined();
    expect([config.extends, config.compilerOptions], "tsconfig.tools.json loosens nothing of tsconfig.json: it extends it and only adds noEmit.").toEqual(["./tsconfig.json", { noEmit: true }]);
    expect(Array.isArray(config.exclude), "Keep the exclude list in tsconfig.tools.json, empty when every file is fixed: the next change compares with it.").toBe(true);
    const inherited = (JSON.parse(read("tsconfig.json")) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
    expect([inherited["strict"], inherited["noCheck"]], "tsconfig.json, which both typechecks extend, keeps full checking: strict, and no noCheck.").toEqual([true, undefined]);
    expect(gitIn(repo, "ls-files", "scripts/*.tmp.ts").stdout.trim(), "A tracked scripts/*.tmp.ts is not typechecked: that name is for untracked probes, so give a script another name.").toBe("");
    // one glob per root: Bun.Glob reads no slash inside braces; the untracked probes are not checked
    const sources = ROOTS.flatMap((root) => files(`${root}/**/*.{ts,tsx}`)).filter((file) => !/^scripts\/[^/]+\.tmp\.ts$/.test(file));
    expect(sources.length).toBeGreaterThan(400);
    fail(hiddenSources(repo),
      "Rename these: tsc's folder include skips a hidden file or folder, so this file would never be typechecked.");
    fail(sources.filter((file) => file.endsWith(".tsx") && sources.includes(file.replace(/\.tsx$/, ".ts"))),
      "Rename one of each pair: beside a .ts of the same name, tsc's folder include leaves the .tsx unchecked.");
    fail(sources.filter((file) => /^\s*(?:\/\/+|\/\*+)\s*@ts-nocheck\b/m.test(read(file))),
      "Fix the type errors in these files instead of `// @ts-nocheck`: a file under the tools typecheck's roots is checked, or listed in its exclude list until it is fixed.");
  });

  it("finds a hidden file whatever its name", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-hidden-sources-"));
    try {
      mkdirSync(join(root, "scripts"));
      for (const name of [".x.ts", ".숨김.ts", "plain.ts"]) writeFileSync(join(root, "scripts", name), "");
      gitIn(root, "init", "-q");
      gitIn(root, "config", "core.quotePath", "true");
      gitIn(root, "add", "scripts");
      expect(hiddenSources(root)).toEqual(["scripts/.x.ts", "scripts/.숨김.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes only files that exist", () => {
    fail(now.filter((file) => !file.includes("*") && !existsSync(join(repo, file))),
      "Remove these entries from the exclude list of tsconfig.tools.json: the files are gone. A renamed file that still has type errors keeps its entry under the new path.");
  });
});

describe("the demo app's file server", () => {
  const OWN_SERVER: Record<string, string> = {
    "scripts/boot-loading-demo-regression.ts": "sends the page's CSP header",
    "scripts/chat-tool-paths-demo-regression.ts": "answers /pane/conversation and /pane/commands",
    "scripts/cliproxy-settings-regression.ts": "passes /api to a real server",
    "scripts/design-gate-qa.ts": "serves the root icons and manifest beside the app",
    "scripts/diff-find-demo-regression.ts": "serves /icons/ beside the app",
    "scripts/diff-line-notes-demo-regression.ts": "serves /icons/ beside the app",
    "scripts/droplet-demo-regression.ts": "rewrites the CSS safe-area inset",
    "scripts/film/capture.ts": "serves the built site, not the demo app",
    "scripts/film/render.ts": "serves the film's stage page and footage",
    "scripts/install-state-demo-regression.ts": "answers manifest.webmanifest with its own body",
    "scripts/old-safari-demo-regression.ts": "sends the page's CSP header",
    "scripts/pages-static.ts": "serves the built Pages site as GitHub Pages does",
    "scripts/pane-mute-demo-run.ts": "answers /fixture/preferences",
    "scripts/phone-glass-header-demo-regression.ts": "rewrites the CSS safe-area inset",
    "scripts/prompt-card-timing-demo-regression.ts": "also serves paths outside /app/",
    "scripts/repo-diff-browser-qa.ts": "serves /icons/ beside the app",
    "scripts/settings-pages-demo-regression.ts": "serves two builds side by side",
    "scripts/settings-palette-search-demo-regression.ts": "serves two builds side by side",
    "scripts/settings-rows-demo-regression.ts": "serves two builds side by side",
    "scripts/setup-dialog-demo-regression.ts": "serves /icons/ beside the app",
    "scripts/setup-row-demo-regression.ts": "serves /icons/ beside the app",
    "scripts/theme-first-paint-demo-regression.ts": "sends the page's CSP header and refuses /api",
    "scripts/usage-account-management-regression.ts": "passes /api to a real server",
  };
  const servesFiles = (code: string): boolean =>
    /\bBun\.serve\s*\(/.test(code) && /\bdecodeURIComponent\s*\(/.test(code) && /\bBun\.file\s*\(/.test(code);
  const servers = files("scripts/**/*.{ts,tsx,mjs,js}").filter((file) => file !== "scripts/demo-server.ts" && file !== "scripts/conventions.test.ts" && servesFiles(stripComments(read(file))));

  it("is serveDemo from scripts/demo-server.ts", () => {
    fail(servers.filter((file) => !(file in OWN_SERVER)),
      "Serve the demo app with serveDemo(dir) from scripts/demo-server.ts (serveDemo(dir, { prefix }) for another path) instead of a Bun.serve of your own: a copy is one more to fix when the server changes. If a script needs something serveDemo does not do, add it to serveDemo as an option. OWN_SERVER in scripts/conventions.test.ts only holds the scripts that had their own before it existed.");
  });

  it("lists only scripts that still serve the files themselves", () => {
    fail(Object.keys(OWN_SERVER).filter((file) => !servers.includes(file)),
      "These scripts no longer serve files themselves: take them out of OWN_SERVER in scripts/conventions.test.ts.");
  });

  it("tells a server of files from one that only answers requests, whatever the spelling", () => {
    expect(servesFiles("Bun.serve( { async fetch(req) { const p = new URL(req.url).pathname; const name = decodeURIComponent( p.slice(base.length)); return new Response(Bun.file( join(root, name))); } })")).toBe(true);
    expect(servesFiles("const server = serveDemo(app, { prefix: \"/\" });")).toBe(false);
    expect(servesFiles("Bun.serve({ fetch: () => Response.json({ turns: [] }) }); const pane = decodeURIComponent(id);")).toBe(false);
  });
});

describe("demo transport", () => {
  // Every push to main redeploys the browser demo, whose server is site/demo/transport.ts: an
  // endpoint or WS frame it does not answer is a 404 or a dropped frame there (AGENTS.md,
  // Changing a contract).
  const demo = stripComments(read("site/demo/transport.ts"));
  const exact = new Set([...demo.matchAll(/["'](\/api\/[^"'?]*)["']/g)].map((match) => match[1]!));
  const prefixes = [...demo.matchAll(/\.startsWith\(\s*["'](\/api\/[^"']+)["']\s*\)/g)].map((match) => match[1]!).filter((prefix) => prefix !== "/api/");
  const answered = (route: string) => exact.has(route) || prefixes.some((prefix) => route.startsWith(prefix));

  const DEMO_404: Record<string, string> = {
    "/api/pane/turn/cancel": "only a live ACP keeper has a turn a person can cancel",
    "/api/pane/turn/release": "only a live ACP keeper can be handed back",
    "/api/pane/turn/cancel-children": "only a pane that started live ACP keepers has children a person can stop",
    "/api/worktree/create-checked": "Only the terminal screen sends checkout mutations bound to a herdr-core identity.",
    "/api/worktree/remove-checked": "Only the terminal screen sends checkout mutations bound to a herdr-core identity.",
    "/api/account/confirm": "a PC-local screen confirmation (the PC's own confirm page); a browser over the demo never answers one",
    "/api/account/confirm-page": "opens the PC's own confirm page for a key that waits: only with the release flag on, which the demo never is",
    "/api/account/forget": "a PC-local recovery act (ovis recover / the PC's screen); the demo's browser never asks for it",
    "/api/account/leave": "the PC leaving its account is a PC-local act; the app's own leave goes through the account service",
    "/api/account/pc-proof": "this PC's own proof for its listing: asked only by a signed-in window on this PC itself, which the demo never is",
    "/api/account/list": "how this PC follows its account's signed list: read by this PC's own window and CLI for diagnosis, and no screen of the app asks for it",
    "/api/account/list/pin": "a person at the PC names the list it pins: this PC's own window and CLI alone, and no screen of the app asks for it yet",
    "/api/account/list/head": "a device and the PC say where the account's signed list stands: the demo's PC follows no list, and 404 is what such a PC answers",
    "/api/account/list/page": "a device hands the PC entries of the account's signed list: the demo's PC follows no list, and 404 is what such a PC answers",
    "/api/account/list/named": "a device that scanned a PC's QR code names its account's list in the place of its link: the demo's PC is in its account and shows no such code",
    "/api/account/list/witness": "a device asks a PC whom it lets in before its account moves onto a signed list: the demo's account never moves",
    "/api/account/list/name": "a device names its account's signed list to a PC that follows none: the demo's account has no list",
    "/api/account/list/card": "a device asks a PC its list carried in for its card: the demo's PC follows no list, and refuses it as such a PC does",
    "/api/account/list/add": "a PC in no account is added to an account that keeps a signed list: asked by `ovis add` and by Add this PC in the PC's own window, and the demo's PC is in its account",
    "/api/account/list/add/confirm": "the person at the PC says the adding device shows the same number: asked by `ovis add` on the PC",
    "/api/account/list/add/cancel": "the person at the PC says the numbers differ: asked by `ovis add` on the PC",
    "/api/account/list/join": "`ovis join` with an invite's line that names the account's list: the CLI on the PC alone",
    "/api/account/list/join/prepare": "`ovis join` with an auto invite: the CLI on the PC alone",
    "/api/account/list/join/body": "`ovis join` with an auto invite: the CLI on the PC alone",
    "/api/account/list/join/place": "`ovis join` with an auto invite: the CLI on the PC alone",
    "/api/runtime/move/install": "the demo reports runtime move unavailable (not_herdr), so the app never offers an install",
    "/api/runtime/move/stop": "the demo reports runtime move unavailable (not_herdr), so the app never offers a stop",
    "/api/runtime/move/stop-all": "the demo reports runtime move unavailable (not_herdr), so the app never offers a stop",
    "/api/account/enroll": "account linking: no screen of the app asks for it yet (the account screens come with their own demo answers)",
    "/api/updates/cancel": "a connection server asks a PC's own Ovis to stop its update; the demo's browser never does",
    "/api/account/introduce": "account linking: no screen of the app asks for it yet (the account screens come with their own demo answers)",
    "/api/account/introduction": "account linking: no screen of the app asks for it yet (the account screens come with their own demo answers)",
    "/api/account/link": "account linking: no screen of the app asks for it yet (the account screens come with their own demo answers)",
    "/api/account/records": "account linking: no screen of the app asks for it yet (the account screens come with their own demo answers)",
    "/api/devices/pending": "devices waiting for this PC's screen: only with the release flag on, which the demo never is",
    "/api/devices/pending/decline": "devices waiting for this PC's screen: only with the release flag on, which the demo never is",
    "/api/devices/tailnet-nodes/block": "keeping a Tailscale device out: the demo lists none, so its removal dialog offers none to choose",
    "/api/devices/tailnet-nodes/answer": "a removed Tailscale device asking to get back in: the demo lists none, so no card asks",
    "/api/account/lock": "strict mode: only with the release flag on, which the demo never is",
    "/api/account/unlock": "strict mode: only with the release flag on, which the demo never is",
    "/api/account/local-confirm": "refused to every caller (local_required): an act is confirmed on the PC's own screen, never through a route",
    "/api/account/relay-account": "relay pass: named by a signed-in owner's account screen, which the demo never reaches (no sign-in there)",
    "/api/account/ssh-add": "adding another PC to the account over SSH: this PC's own window, signed in, after a setup job reached that PC's own Ovis; the demo has no sign-in and no SSH",
    "/api/account/one-press": "one-press PC add: only with the release flag on and after the account service admitted the PC, which the demo never reaches (no sign-in there)",
    "/api/devices/pair/cancel": "called by the plugin's terminal `link --code` only (scripts/plugin-link.ts); no screen of the app asks for it",
    "/api/auth": "the demo is never locked (/api/health says authenticated), so neither the token form nor sign-out runs",
    "/api/bridge": "a remote PC's bridge endpoint, asked by another server, never by the browser",
    "/api/runtime": "switching the runtime: the demo's health carries no herdr_runtime, so Settings offers no Switch",
    "/api/event": "OpenCode v2's own service's event stream, read by this server (opencode-service.ts), never by the browser",
    "/api/info": "OpenCode v2's own service's identity, checked by this server (opencode-service.ts), never by the browser",
    "/api/devices/pair": "pairing a device: the demo is never locked, so the pairing form does not run",
    "/api/relay/pairings": "the waiting relay pairings, read by `plugin.ts pair --approve` in the PC's terminal; the browser hears of them on its event stream",
    "/api/relay/offer/keep": "the state of a code made for an account, by its id: no screen of the app calls this route. This PC itself, or any device with drive access on a direct connection that has the id, may read it",
    "/api/pane/conversation/image": "an image in a chat turn: the demo's transcripts carry none (listed when this guard was added)",
    "/api/pane/conversation/tool-output": "a tool call's full output: not part of the demo (listed when this guard was added)",
    "/api/pane/image": "pasting an image: the demo stores no files (listed when this guard was added)",
    "/api/pane/read": "the scrollback read behind a chat with no transcript: the demo answers /api/pane/conversation instead (listed when this guard was added)",
    "/api/pane/selection": "copying a selection across screens: not part of the demo (listed when this guard was added)",
    "/api/updates/check": "the demo's /api/updates says managed: false, so Settings offers no check",
    "/api/updates/install": "the demo's /api/updates says managed: false, so Settings offers no install",
    "/api/workspace/git/branches": "a repository's history, for API clients: no screen of the app asks for it yet",
    "/api/workspace/git/log": "a repository's history, for API clients: no screen of the app asks for it yet",
    "/api/workspace/git/show": "a repository's history, for API clients: no screen of the app asks for it yet",
  };
  const DEMO_IGNORES: Record<string, string> = {
    "pty-ack": "the demo has no output flow control to release; its switch's default branch drops it",
    "prompt-watch": "the demo does not advertise the prompt-watch feature, and the browser never sends it; its switch's default branch drops it",
  };

  it("answers every /api route the server handles", () => {
    const routes = new Set(files("server/**/*.ts").filter((file) => !/\.test\.ts$|\.fake\.ts$/.test(file))
      .flatMap((file) => [...stripComments(read(file)).matchAll(/["'`](\/api\/[\w./-]*[\w.-])["'`]/g)].map((match) => match[1]!)));
    expect(routes.size).toBeGreaterThan(60);
    fail([...routes].filter((route) => !answered(route) && !(route in DEMO_404)).sort(),
      "Answer these routes in route() in site/demo/transport.ts (with fixtures from site/demo/fixtures.ts), so the demo does not 404. Only a route the browser never asks the demo for (server to server, or behind a state the demo never reaches) goes into DEMO_404 in scripts/conventions.test.ts instead, with its reason.");
    fail(Object.keys(DEMO_404).filter((route) => answered(route) || !routes.has(route)),
      "Remove these entries from DEMO_404 in scripts/conventions.test.ts: the demo answers them now, or the server no longer has them.");
  });

  it("handles every WS frame a client sends", () => {
    const protocol = read("shared/protocol.ts");
    const union = protocol.slice(protocol.indexOf("export type ClientMessage ="), protocol.indexOf("export type ServerFeature"));
    const frames = [...union.matchAll(/\|\s*\{\s*type:\s*"([\w-]+)"/g)].map((match) => match[1]!);
    expect(frames.length).toBeGreaterThan(10);
    const cases = new Set([...demo.matchAll(/\bcase\s+"([\w-]+)"\s*:/g)].map((match) => match[1]!));
    fail(frames.filter((frame) => !cases.has(frame) && !(frame in DEMO_IGNORES)),
      "Handle these ClientMessage frames (shared/protocol.ts) in the demo socket's switch in site/demo/transport.ts, answering the way the server would. A frame that needs no answer goes into DEMO_IGNORES in scripts/conventions.test.ts with its reason.");
    fail(Object.keys(DEMO_IGNORES).filter((frame) => cases.has(frame) || !frames.includes(frame)),
      "Remove these entries from DEMO_IGNORES in scripts/conventions.test.ts: the demo handles them now, or the protocol no longer has them.");
  });
});

describe("names from before Ovis", () => {
  const CARRY_OVER: Record<string, string> = {
    "server/legacy-env.ts": "maps each old setting to its new name",
    "server/legacy-env.test.ts": "tests that mapping",
    "src/lib/legacyStorage.ts": "moves old browser storage keys",
    "src/lib/legacyStorage.test.ts": "tests that move",
    "server/auth.ts": "still accepts and clears the old cookies",
    "server/auth.test.ts": "tests the old cookies",
    "server/pty/pty-host.mjs": "keeps the token from the attach under either name",
    "server/pty/session.ts": "keeps the token from the sidecar under either name",
    "crates/pty-sidecar/src/pty.rs": "keeps the token from the attach under either name, as pty-host.mjs does",
    "server/pty/host.test.ts": "tests that both PTY hosts keep the token from the command under either name",
    "server/remote-host.ts": "a remote bundle published before the rename reads the old name",
    "install.sh": "reads the old settings of an earlier install",
    "scripts/plugin-tui.ts": "withholds the old token name from ovis tui too, as a shell set up for an earlier install may export it",
    "scripts/plugin-tui.test.ts": "tests that ovis tui gets the old token name no more than the new one",
    "crates/ovis-tui/src/main.rs": "removes the old token name from its environment too, as plugin-tui.ts withholds it",
    "scripts/install-herdr-core.test.ts": "tests that install.sh replaces an earlier install's runtime under its old name",
    "scripts/install-ovis-command.test.ts": "tests that the ovis command reads an earlier install's state dir setting under its old name",
    "install.ps1": "reads the old settings of an earlier install",
    "app/windows/src/Setup.cs": "reads the token of an earlier install's settings, as install.ps1 does",
    "app/windows/tests/SetupTests.cs": "tests that read",
    "docs/guide.md": "tells users the old names still work",
    "shared/telemetry.ts": "pinned to the deployed telemetry Worker, so not even a comment changes",
  };
  // released notes keep the names they shipped with; telemetry/ is the deployed Worker's source
  const HISTORY = [":!CHANGELOG.md", ":!release-summaries.json", ":!changelog.d", ":!telemetry"];

  it("appear only where an older install hands them in", () => {
    const grep = spawnSync("git", ["grep", "--untracked", "-I", "-l", "-E", "HERDR_WEB_[A-Z0-9_]+|herdr_web_(token|device)|herdr-web-ui[:]|[/\"'`][.]herdr-web-ui([^a-z.-]|$)", "--", ".", ...HISTORY], { cwd: repo, encoding: "utf8" });
    if (grep.status === null || grep.status > 1) return;
    const offenders = grep.stdout.split("\n").filter((file) => file !== "" && !(file in CARRY_OVER));
    fail(offenders, "Use the Ovis names: OVIS_* for settings, ovis_token and ovis_device for cookies, ovis:* for browser storage keys, .ovis for pasted files. The old names are read only by the files in CARRY_OVER (scripts/conventions.test.ts), which carry an older install over.");
  });
});

describe("raw NUL bytes", () => {
  // A raw 0x00 in a source file still compiles, but git and review tools then show the file's
  // diff as binary, so whatever else changed in it goes unreviewed. Tracked text is read as bytes
  // (offsets are byte offsets), listed with `git ls-files -z` (a path may hold a newline).
  // Every tracked file is text except these binary formats. git's own binary flag cannot choose:
  // a text file with a NUL in it is exactly what git starts calling binary.
  const BINARY_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf", ".webm", ".mp4", ".mov", ".mp3", ".wav", ".pdf", ".zip", ".gz", ".tgz", ".jar", ".wasm", ".dmg"]);

  const isText = (path: string): boolean => {
    const name = path.split("/").at(-1)!;
    const dot = name.lastIndexOf(".");
    return dot < 0 || !BINARY_SUFFIXES.has(name.slice(dot).toLowerCase());
  };

  const nulAt = (path: string, bytes: Uint8Array): string | null => {
    const at = bytes.indexOf(0);
    return at < 0 ? null : `${JSON.stringify(path)}: raw NUL at byte ${at}`;
  };

  const scanNul = (root: string, env: Record<string, string | undefined> = process.env): { scanned: number; offenders: string[] } => {
    const listed = spawnSync("git", ["ls-files", "-z", "--cached"], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 });
    if (listed.error || listed.status !== 0) {
      return { scanned: 0, offenders: [`git ls-files -z --cached failed in ${root}: ${listed.error?.message ?? `exit ${listed.status}, ${listed.stderr.toString().trim()}`}`] };
    }
    const top = realpathSync(root) + sep;
    let scanned = 0;
    // git lists raw name bytes: a name that is not valid UTF-8 cannot be opened by its decoded name
    const names: string[] = [];
    const badNames: string[] = [];
    for (let start = 0; start < listed.stdout.length;) {
      const end = listed.stdout.indexOf(0, start);
      const raw = listed.stdout.subarray(start, end < 0 ? listed.stdout.length : end);
      start = end < 0 ? listed.stdout.length : end + 1;
      if (!raw.length) continue;
      const name = raw.toString("utf8");
      (Buffer.from(name, "utf8").equals(raw) ? names : badNames).push(name);
    }
    const offenders = [...new Set(badNames)].map((name) => `${JSON.stringify(name)}: path is not valid UTF-8, so it cannot be read`).concat([...new Set(names)].filter(isText).flatMap((path) => {
      const file = join(root, path);
      let bytes: Uint8Array;
      try {
        const entry = lstatSync(file, { throwIfNoEntry: false });
        if (!entry || entry.isSymbolicLink() || !realpathSync(file).startsWith(top)) return [];
        if (!entry.isFile()) return [`${JSON.stringify(path)}: not a regular file`];
        bytes = readFileSync(file);
      } catch (error) {
        return [`${JSON.stringify(path)}: unreadable, ${(error as Error).message}`];
      }
      scanned += 1;
      const found = nulAt(path, bytes);
      return found ? [found] : [];
    }));
    return { scanned, offenders };
  };

  it("keeps tracked text free of raw NUL bytes", () => {
    const { scanned, offenders } = scanNul(repo);
    fail(offenders, "Remove the raw NUL (0x00) bytes from these tracked text files: one makes git and review tools show the file's diff as binary, which hides the rest of the change from review. Write the escape (\"\\0\", \"\\u0000\", \"\\x00\") in source instead, and give a binary asset a binary suffix (BINARY_SUFFIXES in scripts/conventions.test.ts).");
    expect(scanned).toBeGreaterThan(1000);
  });

  /** A throwaway repository holding `tracked` in its index and `untracked` beside it; `run` gets its root and a git environment that cannot reach another repository. */
  const withRepo = (tracked: Record<string, string | Uint8Array>, untracked: Record<string, string | Uint8Array>, run: (root: string, env: Record<string, string | undefined>) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "tracked-text-"));
    const root = join(dir, "repo");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gitconfig") });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
    };
    try {
      mkdirSync(root);
      git("init", "-q");
      for (const [path, content] of Object.entries({ ...tracked, ...untracked })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      if (Object.keys(tracked).length) git("add", "--", ...Object.keys(tracked));
      run(root, env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("tracked text reports first raw NUL byte offset", () => {
    expect(nulAt("a.ts", Buffer.from("\0a\0"))).toBe("\"a.ts\": raw NUL at byte 0");
    expect(nulAt("src/new\nline.ts", Buffer.from("const s = \"é한\";\0\0"))).toBe("\"src/new\\nline.ts\": raw NUL at byte 18");
    expect(nulAt("a.ts", Buffer.from("clean"))).toBeNull();
    // Windows forbids a newline in a file name
    if (process.platform !== "win32") withRepo({ "docs/zero.md": "\0# Title\n", "src/new\nline.ts": "const s = \"é한\";\0\n" }, {}, (root, env) => {
      expect(scanNul(root, env)).toEqual({ scanned: 2, offenders: ["\"docs/zero.md\": raw NUL at byte 0", "\"src/new\\nline.ts\": raw NUL at byte 18"] });
    });
  });

  it("reads tracked text in any directory and with any name", () => {
    withRepo({ "crates/pty-sidecar/Cargo.lock": "version = 4\n\0", "tools/new.ts": "export {};\0", "Brewfile": "\0" }, {}, (root, env) => {
      expect(scanNul(root, env)).toEqual({ scanned: 3, offenders: ["\"Brewfile\": raw NUL at byte 0", "\"crates/pty-sidecar/Cargo.lock\": raw NUL at byte 12", "\"tools/new.ts\": raw NUL at byte 10"] });
    });
  });

  it("escaped NUL source remains text", () => {
    withRepo({ "src/escaped.ts": "const a = \"\\0\";\nconst b = \"\\u0000\";\nconst c = /\\x00/;\n", "server/x.sql": "SELECT char(0);\n" }, {}, (root, env) => {
      expect(scanNul(root, env)).toEqual({ scanned: 2, offenders: [] });
    });
  });

  it("fails closed on a tracked name that is not valid UTF-8", () => {
    withRepo({}, {}, (root, env) => {
      // in the index only: macOS and Windows refuse such a name on disk, and the scan reports it before looking there
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, env, input: "a\0", encoding: "utf8" }).stdout.trim();
      const entry = Buffer.concat([Buffer.from(`100644 ${blob}\tsrc/x`), Buffer.from([0xff]), Buffer.from(".md\n")]);
      expect(spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: root, env, input: entry }).status).toBe(0);
      expect(scanNul(root, env)).toEqual({ scanned: 0, offenders: ["\"src/x\uFFFD.md\": path is not valid UTF-8, so it cannot be read"] });
    });
  });

  it.skipIf(process.platform === "win32")("NUL-delimited filenames survive spaces newlines and Unicode", () => {
    const tracked = { "src/with space.ts": "a\0", "src/two\nlines.ts": "ab\0", "src/日本 語.md": "日\0", "src/conflict.ts": "abcd\0" };
    withRepo(tracked, {}, (root, env) => {
      // an unmerged path is listed once per stage; it is still read and reported once
      const blob = spawnSync("git", ["hash-object", "-w", "--", "src/conflict.ts"], { cwd: root, env, encoding: "utf8" }).stdout.trim();
      const stages = spawnSync("git", ["update-index", "--index-info"], { cwd: root, env, input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tsrc/conflict.ts\n`).join("") });
      expect(stages.status).toBe(0);
      expect(scanNul(root, env).offenders.sort()).toEqual([
        "\"src/conflict.ts\": raw NUL at byte 4",
        "\"src/two\\nlines.ts\": raw NUL at byte 2",
        "\"src/with space.ts\": raw NUL at byte 1",
        "\"src/日本 語.md\": raw NUL at byte 3",
      ]);
    });
  });

  it("binary, untracked, deleted and linked files are not read", () => {
    const nul = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
    expect(["bun.lock", "crates/pty-sidecar/Cargo.lock", "tools/new.ts", "LICENSE", "src/README", "app/ios/App.swift", "scripts/fixtures/a.ansi", "dist/index.js"].filter((path) => !isText(path))).toEqual([]);
    expect(["src/fonts/a.woff2", "src/icon.png", "app/Icon.PNG", "ovis-site/a.webp", "ovis-site/a.jpg", "public/favicon.ico", "app/android/gradle/wrapper/gradle-wrapper.jar", "site/clip.webm"].filter(isText)).toEqual([]);
    const outside = mkdtempSync(join(tmpdir(), "tracked-text-outside-"));
    try {
      writeFileSync(join(outside, "target.ts"), "\0");
      withRepo({
        "src/fonts/inter.woff2": nul, "public/fonts/inter.woff2": nul, "app/icon.png": nul, "src/gone.ts": "\0", "src/ok.ts": "export {};\n",
      }, { "src/untracked.ts": "\0" }, (root, env) => {
        rmSync(join(root, "src/gone.ts"));
        symlinkSync(join(outside, "target.ts"), join(root, "src/link.ts"));
        expect(spawnSync("git", ["add", "--", "src/link.ts"], { cwd: root, env }).status).toBe(0);
        expect(scanNul(root, env)).toEqual({ scanned: 1, offenders: [] });
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fails closed when git or a tracked text file cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracked-text-nogit-"));
    try {
      const { offenders } = scanNul(dir, { ...process.env, GIT_DIR: join(dir, "missing"), GIT_CEILING_DIRECTORIES: dir });
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toStartWith(`git ls-files -z --cached failed in ${dir}: exit `);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    withRepo({ "src/a.ts": "a\n" }, {}, (root, env) => {
      rmSync(join(root, "src/a.ts"));
      mkdirSync(join(root, "src/a.ts"));
      expect(scanNul(root, env).offenders).toEqual(["\"src/a.ts\": not a regular file"]);
    });
  });

  // root reads any file whatever its mode, so only another user can see a read fail
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails closed on a tracked text file it may not read", () => {
    withRepo({ "src/locked.ts": "a\n" }, {}, (root, env) => {
      chmodSync(join(root, "src/locked.ts"), 0o000);
      const { offenders } = scanNul(root, env);
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toStartWith("\"src/locked.ts\": unreadable, EACCES");
    });
  });
});
