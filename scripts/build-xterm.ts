/** xterm's source uses const enums in .d.ts files; TypeScript must inline them before Vite. */
import ts from "typescript-api";
import type { BunPlugin } from "bun";
import type { Terminal } from "@xterm/xterm";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A finished directory is never written again: builds running at once in one checkout (the browser
 * lane's workers) read it while another may be emitting, and a module rewritten in place reads as
 * missing its exports (#2021).
 *
 * TypeScript compiles the very bytes that were hashed, never the files as they are on disk by then: a
 * source changed in between would otherwise be published under the old source's key (#2148).
 */
export function buildXtermSource(root: string): string {
  // the package's own path: through a symlink TypeScript would resolve imports out of it, to disk
  const source = join(realpathSync(join(root, "node_modules/@xterm/xterm")), "src");
  const cache = join(root, "node_modules/.cache/herdr-xterm");
  const manifest = join(source, "../package.json");
  const files = ts.sys.readDirectory(source, [".ts"], undefined, ["**/*"]).sort();
  // the patch also edits xterm's public typings, which the emit type-checks against
  const typings = ts.sys.readDirectory(join(source, "../typings"), [".ts"], undefined, ["**/*"]).sort();
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: source,
    // xterm 6's VS Code base (src/vs) resolves vs/nls to its own stub, and is written for catch
    // variables typed any: xterm's repository builds it so (src/vs/tsconfig.json, not in the package)
    paths: {
      "browser/*": [join(source, "browser/*")], "common/*": [join(source, "common/*")],
      "vs/nls": [join(source, "vs/patches/nls")], "vs/*": [join(source, "vs/*")],
    },
    useUnknownInCatchVariables: false,
    experimentalDecorators: true, useDefineForClassFields: false,
    skipLibCheck: true, types: [], noEmitOnError: true,
  };
  const key = createHash("sha256").update(`${ts.version}\0${JSON.stringify(options)}\0`);
  // the manifest's `types` picks the typings that `@xterm/xterm` imports resolve to
  const hashed = new Map<string, string>();
  for (const file of [...files, ...typings, manifest]) {
    const content = readFileSync(file);
    key.update(`${relative(source, file)}\0${content.length}\0`).update(content);
    hashed.set(canonical(file), content.toString("utf8").replace(/^\uFEFF/, ""));
  }
  const version = JSON.parse(hashed.get(canonical(manifest))!).version;
  if (version !== "6.0.0") throw new Error("Revalidate the xterm composition backport before changing xterm versions");
  const output = join(cache, key.digest("hex").slice(0, 16));
  if (existsSync(output)) return output;
  mkdirSync(cache, { recursive: true });
  removeAbandonedStaging(cache);
  const staging = mkdtempSync(`${output}.tmp-${process.pid}-`);
  try {
    const host = ts.createCompilerHost(options);
    const xterm = canonical(join(source, "..")) + "/";
    const { fileExists, readFile, realpath, writeFile } = host;
    const inside = (path: string) => canonical(path).startsWith(xterm);
    host.readFile = (path) => inside(path) ? hashed.get(canonical(path)) : readFile(path);
    host.fileExists = (path) => inside(path) ? hashed.has(canonical(path)) : fileExists(path);
    host.realpath = (path) => inside(path) ? path : realpath ? realpath(path) : path;
    const written: string[] = [];
    host.writeFile = (path, ...rest) => { written.push(path); writeFile(path, ...rest); };
    const program = ts.createProgram(files, { ...options, outDir: staging }, host);
    const emitted = program.emit();
    // a file TypeScript could not write is only a diagnostic: never publish a build missing it
    if (emitted.emitSkipped || emitted.diagnostics.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
      const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
      throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
      }));
    }
    // a staging directory another build took for abandoned loses files TypeScript never reports
    const lost = written.filter((path) => !existsSync(path));
    if (lost.length) throw new Error(`The xterm build lost ${lost.length} emitted files before publishing, ${lost[0]} first`);
    // mkdtemp's 0700 would lock other users of this checkout out of the published build
    chmodSync(staging, 0o755);
    moveIntoPlace(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
  return output;
}

/**
 * Bun.build's resolution of the source `buildXtermSource` emitted, as vite.config.ts aliases it:
 * `@xterm/xterm` to its public Terminal, its own `browser/`, `common/` and `vs/` imports to their
 * files, and `vs/nls` to xterm 6's stub.
 */
export function xtermSourcePlugin(xterm: string): BunPlugin {
  return {
    name: "xterm-source",
    setup(build) {
      build.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({ path: join(xterm, "browser/public/Terminal.js") }));
      build.onResolve({ filter: /^vs\/nls$/ }, () => ({ path: join(xterm, "vs/patches/nls.js") }));
      build.onResolve({ filter: /^(browser|common|vs)\// }, ({ path }) => ({ path: join(xterm, path + ".js") }));
    },
  };
}

/** The patched Terminal the app ships, for a test under Bun (the package's own build lacks the patch). */
export async function patchedTerminal(root: string): Promise<typeof Terminal> {
  const source = buildXtermSource(root);
  const bundle = await Bun.build({ entrypoints: [join(source, "browser/public/Terminal.js")], plugins: [xtermSourcePlugin(source)], target: "bun" });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not build xterm");
  const xterm: { Terminal: typeof Terminal } = await import(`data:text/javascript;base64,${Buffer.from(await bundle.outputs[0]!.text()).toString("base64")}`);
  return xterm.Terminal;
}

function canonical(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames ? slashed : slashed.toLowerCase();
}

/**
 * Removes the staging directories of builds that died before finishing (SIGKILL, OOM, Ctrl-C), which
 * would otherwise stay until node_modules is reinstalled. A staging directory whose process still
 * runs belongs to a build emitting right now and is left alone, and so is any written to in the last
 * minutes: a build in another pid namespace (a container on the same checkout) looks dead from here.
 */
function removeAbandonedStaging(cache: string, now = Date.now()): void {
  for (const name of readdirSync(cache)) {
    if (!name.includes(".tmp-")) continue;
    const pid = Number(/\.tmp-(\d+)-[^.]+$/.exec(name)?.[1]);
    if (pid && running(pid)) continue;
    const path = join(cache, name);
    let changed: number;
    try { changed = statSync(path).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (now - changed < STAGING_GRACE_MS) continue;
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Far longer than an emit takes (seconds), even on a loaded runner. */
const STAGING_GRACE_MS = 10 * 60_000;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, under another user
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Renames a finished build into place; losing to another build that got there first is fine. On
 * Windows a scanner (Defender, the indexer) can hold a fresh file for a moment and refuse the rename,
 * so it is tried again until a deadline.
 */
function moveIntoPlace(staging: string, output: string): void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      renameSync(staging, output);
      return;
    } catch (error) {
      if (existsSync(output)) return;
      const held = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
      if (!held || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
