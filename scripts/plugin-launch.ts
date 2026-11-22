/**
 * herdr's way into Ovis: herdr-plugin.toml names this file for every command (through scripts/with-bun.sh, and
 * scripts/plugin.ps1 on Windows). It installs the server of this checkout's version (package.json) from its release
 * when that is not installed yet, checked by scripts/server-install.ts (the manifest's signature by the committed key,
 * then the size and SHA-256 of each file) and moved in by one rename, then runs `ovis-server plugin <command>`.
 *
 * The server goes into .ovis/server in this checkout: herdr gives its build step no state dir, and every later command
 * runs what that step installed once it still verifies (scripts/server-install.ts verifiedInstall), so a first start
 * needs no network. OVIS_RELEASES_URL names another place for releases: https://, or a file:// folder.
 *
 * Source instead of the binary (INSTALL.md, "Binary or source"; install.sh's pick_install is wider for now): with
 * OVIS_FROM_SOURCE=1 (a developer checkout, or a branch install.sh hands to herdr), when this version's release ships no
 * ovis-server.json at all (HTTP 404, or none in a file:// folder: a release from before the compiled server) or a signed
 * one of the shape from before schema 1, and when the manifest's sources are not this checkout's (other git trees). A
 * manifest that fails any other check (its signature among them), a server error or a network failure is a failure,
 * never a reason to build from source.
 * .ovis/server/source-build is what that build came to (install.ps1 reads it): `started` from its first step, and the
 * version and the checkout's commit (the version alone in a folder that has none: see checkoutCommit) only once every
 * step returned 0, and only when git read the same answer before and after the build. Without git on PATH the launcher
 * still runs: the release's binary is installed only for sources git can tie to it (scripts/server-manifest.ts
 * sourceTrees), so such a checkout runs from source, saying why, without asking the release (scripts/server-install.ts):
 * nothing it answers could change that, and a release out of reach does not stop it. These checks decide a new install
 * only: short of OVIS_FROM_SOURCE=1 or a marker, a binary of this version installed earlier that still verifies runs,
 * whatever the sources (installServer looks for it first). Wherever the sources run without a marker for this version
 * (that case, or a release with no compiled server for them), `start`, the one command that brings a server up, runs
 * only a build that is complete (see `builtState`), saying so where it is another version's or commit's, and only a
 * start remembers the choice.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { hostPlatform, installServer, NoBinaryRelease, releasesBase } from "./server-install.ts";
import { sourceTrees } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const USAGE = "usage: bun scripts/plugin-launch.ts install | <command> [flags]   (the commands of scripts/plugin.ts: start, stop, status, phone-setup, add, ...)";

/** a process `signal` ended exits with this, as a shell says it: 128 + the signal's number on this platform */
const signalExit = (signal: NodeJS.Signals): number => 128 + constants.signals[signal];

export async function run(argv: string[], env: Record<string, string> = {}, received: { signal?: NodeJS.Signals } = {}): Promise<number> {
  // the child takes back what it handed out (a pairing code) on SIGTERM or SIGHUP: pass them on, and let Ctrl+C reach
  // it alone (it shares the terminal) instead of ending this launcher before it. Listening starts before the child does,
  // so a signal that comes while it starts no longer ends this launcher with the child left running: Bun runs a listener
  // from the event loop, so one for a signal that came before the spawn returned runs once `child` is set.
  let child: Bun.Subprocess | undefined;
  const forward = (signal: NodeJS.Signals) => () => { received.signal ??= signal; try { child?.kill(signal); } catch {} };
  const handlers = { SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP"), SIGINT: () => {} } as const;
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    child = Bun.spawn(argv, { cwd: root, env: { ...process.env, ...env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    return child.signalCode ? signalExit(child.signalCode) : code;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
}

async function fromSource(command: string, args: string[]): Promise<number> {
  if (command !== "install") return await run([process.execPath, join(root, "scripts", "plugin.ts"), command, ...args]);
  const received: { signal?: NodeJS.Signals } = {};
  for (const step of [["install"], ["run", "build"], [join(root, "scripts", "pty-sidecar.ts"), "install"]]) {
    const code = await run([process.execPath, ...step], {}, received);
    if (code !== 0) return code;
    if (received.signal) return signalExit(received.signal);
  }
  return 0;
}

/**
 * What git answers for the checkout in a folder, by one rule that install.ps1 (Read-InstalledCommit) and install.sh
 * (ref_not_moved) read it by too: a checkout's top level has its commit; a folder inside another repository
 * (`--show-prefix` names its path there) or one git says is no repository has none of its own; anything else (git's
 * own error, a lock, no git on PATH) is git failing, on which nothing may be decided. A folder git distrusts (another
 * account owns it) fails on every call: `trust` is the command that trusts it, for this platform's shell (PowerShell on
 * Windows), built from the folder git names on its first line (the command git prints is quoted for a POSIX shell). On
 * Windows herdr shows this launcher's stderr, from where it may as well be pasted into cmd.exe, which keeps single quotes:
 * `trustCmd` is the same command for cmd.exe, double-quoted, and none for a folder with a `%` or a `!` (cmd.exe would
 * expand `%name%` there, and `!name!` under delayed expansion).
 */
export type CheckoutCommit = { commit: string } | { none: "nested" | "no checkout" } | { failed: string; trust?: string; trustCmd?: string };

/** `text` as one argument of the platform's shell: PowerShell on Windows, POSIX elsewhere */
const shellQuote = (text: string, platform = process.platform): string =>
  platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;

export function gitFailed(err: string, platform = process.platform): CheckoutCommit {
  const first = err.split(/\r?\n/)[0]!;
  const owned = /^fatal: detected dubious ownership in repository at '(.*)'$/.exec(first);
  if (!owned) return { failed: err };
  const folder = owned[1]!;
  const trust = (quoted: string) => `git config --global --add safe.directory ${quoted}`;
  if (platform !== "win32") return { failed: first, trust: trust(shellQuote(folder, platform)) };
  return { failed: first, trust: trust(shellQuote(folder, platform)), ...(/[%!]/.test(folder) ? {} : { trustCmd: trust(`"${folder}"`) }) };
}

const said = (answer: CheckoutCommit): string =>
  "commit" in answer ? `commit ${answer.commit.slice(0, 12)}` : "none" in answer ? (answer.none === "nested" ? "a folder inside another repository" : "no git checkout") : "git failing";

export async function checkoutCommit(dir = root): Promise<CheckoutCommit> {
  // git's own words, untranslated: "not a git repository" is told from its other errors by them
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", dir, ...args], { env: { ...process.env, LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out: out.trim(), err: err.trim() || `git exited with ${code}`, code };
  };
  try {
    const prefix = await git("rev-parse", "--show-prefix");
    if (prefix.code !== 0) return /not a git repository/.test(prefix.err) ? { none: "no checkout" } : gitFailed(prefix.err);
    if (prefix.out !== "") return { none: "nested" };
    const head = await git("rev-parse", "HEAD");
    return head.code === 0 && head.out !== "" ? { commit: head.out } : gitFailed(head.err);
  } catch (error) {
    return { failed: (error as NodeJS.ErrnoException).code === "ENOENT" ? "git is not on PATH" : String(error) };
  }
}

export async function main(args: string[], { home = join(root, ".ovis", "server"), source = fromSource, fetchFile, sources = sourceTrees(root), commit = () => checkoutCommit() }: { home?: string; source?: typeof fromSource; fetchFile?: typeof fetch; sources?: ReturnType<typeof sourceTrees>; commit?: () => Promise<CheckoutCommit> } = {}): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || ["--help", "-h", "help"].includes(command)) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const platform = hostPlatform();
  // The build step's choice of source, whatever made it (OVIS_FROM_SOURCE=1, which install.sh sets for a branch, or a
  // release without ovis-server.json), is remembered for this checkout's version, and every later command, which herdr
  // runs without that variable, keeps it. The next build step (a later install, or herdr plugin update) decides anew:
  // without the variable it drops the choice and asks the release again.
  const marker = join(home, "from-source");
  const remember = () => { mkdirSync(home, { recursive: true }); writeFileSync(marker, `${version}\n`); };
  // The marker is the choice, written before the build; the stamp says whether the build finished. It says `started`
  // before the marker is written and names the version and commit only after every step returned 0, so a build that
  // failed or was cut off (in bun install, or over the packages and client of an earlier build) is never taken as
  // finished. A checkout without a stamp was built by a launcher from before it, or took the release's binary. The
  // commit is the one the build started from: a checkout that moved meanwhile (a pull while bun install ran) holds
  // sources other than the ones built, and its build stays `started`. So does one where git failed, before or after:
  // the version alone would claim a folder with no commit of its own, and install.ps1 would take it as built.
  const stamp = join(home, "source-build");
  const build = async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(stamp, "started\n");
    remember();
    const builtFrom = await commit();
    const code = await source("install", rest);
    if (code !== 0) return code;
    const now = await commit();
    const failed = "failed" in builtFrom ? builtFrom : "failed" in now ? now : null;
    if (failed !== null) {
      console.error(`Ovis: git could not read the checkout's commit (${failed.failed}), so the build is not marked finished`);
      if (failed.trust) {
        const windows = process.platform === "win32";
        console.error(`Ovis: git does not trust this folder (another account owns it); to trust it, run${windows ? " in PowerShell" : ""}:\n${failed.trust}`);
        if (failed.trustCmd) console.error(`Ovis: or in cmd.exe:\n${failed.trustCmd}`);
      }
    }
    else if (JSON.stringify(now) !== JSON.stringify(builtFrom)) {
      console.error("commit" in now && "commit" in builtFrom
        ? "Ovis: the checkout moved to another commit while it was built, so the build is not marked finished"
        : `Ovis: git's answer for the checkout changed while it was built (${said(builtFrom)} before, ${said(now)} after), so the build is not marked finished`);
    }
    else writeFileSync(stamp, `${"commit" in builtFrom ? `${version} ${builtFrom.commit}` : version}\n`);
    return code;
  };
  // A build is this checkout's when its stamp is absent (a launcher from before it wrote none) or names this version and,
  // where git reads the checkout's commit, that commit, as `build` stamps it (the version alone in a folder with no commit
  // of its own). install.ps1's $sourceBuilt reads the stamp by the same rule, but for one case: where git fails it takes
  // no stamp at all (it refuses then), while here, where git failing (not on PATH, a folder it distrusts) is the usual
  // reason the sources run at all, the version decides.
  const rebuild = process.platform === "win32"
    ? `$env:OVIS_FROM_SOURCE = '1'; bun ${shellQuote(join(root, "scripts", "plugin-launch.ts"))} install`
    : `OVIS_FROM_SOURCE=1 bun ${shellQuote(join(root, "scripts", "plugin-launch.ts"))} install`;
  const builtState = async (): Promise<{ missing: string[]; stale: string | null }> => {
    const stamped = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
    const missing = [
      ...(existsSync(join(root, "node_modules")) ? [] : ["no node_modules"]),
      ...(existsSync(join(root, "dist", "index.html")) ? [] : ["no dist/index.html"]),
      ...(stamped === "started" ? ["its last build did not finish"] : []),
    ];
    if (missing.length > 0 || stamped === null || stamped === "started") return { missing, stale: null };
    const [built, builtFrom] = stamped.split(" ");
    if (built !== version) return { missing, stale: `version ${built} while the checkout is at version ${version}` };
    const now = await commit();
    if ("commit" in now && builtFrom !== now.commit) return { missing, stale: `${builtFrom ? `commit ${builtFrom.slice(0, 12)}` : "no commit"} while the checkout is at commit ${now.commit.slice(0, 12)}` };
    return { missing, stale: null };
  };
  if (command === "install") {
    rmSync(marker, { force: true });
    rmSync(stamp, { force: true });
    if (process.env["OVIS_FROM_SOURCE"] === "1") return await build();
  } else if (process.env["OVIS_FROM_SOURCE"] === "1" || (existsSync(marker) && readFileSync(marker, "utf8").trim() === version)) {
    return await source(command, rest);
  }
  let binary: string;
  try {
    const result = await installServer({
      // the release's binary is installed only for the sources it was built from (one installed already that still
      // verifies runs as it is): a branch or main between releases builds its own
      home, version, fetchFile, sources,
      // the Rust PTY host comes with it, the one the signed manifest names (scripts/server-install.ts)
    });
    if (result.installed || command === "install") console.error(`Ovis: ${result.message}`);
    binary = result.binary;
  } catch (error) {
    if (error instanceof NoBinaryRelease) {
      if (command === "install") {
        console.error(`Ovis: ${error.message}, so this checkout runs from source`);
        return await build();
      }
      if (command === "start") {
        const { missing, stale } = await builtState();
        if (missing.length > 0) {
          console.error(`Ovis: ${error.message}, and this checkout has no finished build of its own (${missing.join(", ")}), so nothing was started. To build it, run:\n${rebuild}`);
          return 1;
        }
        if (stale !== null) console.error(`Ovis: this checkout's build is of ${stale}; to rebuild it, run: ${rebuild}`);
      }
      if ("error" in sources) {
        console.error(`Ovis: ${error.message}, so this checkout runs its own build`);
        return await source(command, rest);
      }
      console.error(`Ovis: ${error.message}, so this checkout runs from source`);
      // only by a start that found the build complete: the marker sends later starts to the sources before any check
      if (command === "start") remember();
      return await source(command, rest);
    }
    const why = error instanceof Error ? error.message : String(error);
    if (command === "stop" || command === "status") {
      console.error(`Ovis: could not install the server of v${version} (${why}), so this checkout's ${command} runs from source`);
      return await source(command, rest);
    }
    console.error(`Ovis: could not install the server of v${version}: ${why}`);
    return 1;
  }
  if (command === "install") return 0;
  return await run([binary, "plugin", command, ...rest], { OVIS_PLUGIN_CHECKOUT: root });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
