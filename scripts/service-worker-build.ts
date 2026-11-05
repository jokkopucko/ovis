import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { RELAY_RESOURCE_TARGET, REQUEST_HEADERS, RESPONSE_HEADERS } from "../shared/relay-mux.ts";

/** The line public/sw.js carries until a build names itself in it. */
const UNSTAMPED = 'const BUILD = "";';

/**
 * A build's name: the hashed files it emits. Vite names every file under assets/ after its
 * contents, so two builds that serve the same files share it and any changed file moves it.
 */
export function buildId(fileNames: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const name of [...fileNames].filter((name) => name.startsWith("assets/")).sort()) hash.update(`${name}\0`);
  return hash.digest("hex").slice(0, 12);
}

/** The line public/sw.js carries until a build lists its files in it. */
const UNLISTED = "const BUILD_FILES = null;";

function stampLine(source: string, line: string, stamped: string): string {
  const at = source.indexOf(line);
  if (at === -1 || source.indexOf(line, at + 1) !== -1) throw new Error(`public/sw.js must hold exactly one \`${line}\` line`);
  return source.replace(line, () => stamped);
}

/**
 * The files of a build the worker keeps for it (BUILD_FILES in sw.js): its hashed /assets/ files as
 * the page asks for them. Typefaces are left out (they live in a cache no build retires), and so are
 * the precompressed copies, which no page asks for by name.
 */
export function buildFiles(fileNames: Iterable<string>): string[] {
  return [...fileNames]
    .filter((name) => name.startsWith("assets/") && !/\.(woff2?|ttf|br|gz|map)$/.test(name))
    .sort()
    .map((name) => `/${name}`);
}

/**
 * public/sw.js as one build serves it: its cache named after that build (see BUILD in sw.js) and,
 * when `files` is given, the build's files listed (BUILD_FILES).
 */
export function stampServiceWorker(source: string, build: string, files?: readonly string[], shell = false): string {
  if (!/^[0-9a-f]+$/.test(build)) throw new Error(`not a build id: ${build}`);
  for (const file of files ?? []) if (!/^\/assets\/[\w.@~/-]+$/.test(file) || file.includes("..")) throw new Error(`not a build file: ${file}`);
  // both lines must be there, so a build never ships a worker with only one of them stamped
  stampLine(source, UNLISTED, UNLISTED);
  let named = stampLine(source, UNSTAMPED, `const BUILD = "${build}";`);
  if (shell) named = stampLine(named, "const RELAY_RESOURCES = null;",
    `const RELAY_RESOURCES = ${JSON.stringify({ target: RELAY_RESOURCE_TARGET, headers: RESPONSE_HEADERS, requestHeaders: REQUEST_HEADERS })};`);
  return files ? stampLine(named, UNLISTED, `const BUILD_FILES = ${JSON.stringify(files)};`) : named;
}

/**
 * Stamps dist/sw.js with the build, so every build installs a worker whose cache holds only its
 * own files. Vite copies public/ unchanged before the bundle is written, so this runs after.
 */
export function serviceWorkerBuild(shell = false): Plugin {
  let build = "";
  let files: string[] = [];
  return {
    name: "service-worker-build",
    apply: "build",
    generateBundle(_options, bundle) { build = buildId(Object.keys(bundle)); files = buildFiles(Object.keys(bundle)); },
    writeBundle(options) {
      const path = options.dir ? join(options.dir, "sw.js") : null;
      if (!path || !existsSync(path)) return;
      writeFileSync(path, stampServiceWorker(readFileSync(path, "utf8"), build, files, shell));
    },
  };
}
