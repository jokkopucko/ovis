import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { RELAY_RESOURCE_TARGET, REQUEST_HEADERS, RESPONSE_HEADERS } from "../shared/relay-mux.ts";

const UNSTAMPED = 'const BUILD = "";';

/**
 * Vite names every file under assets/ after its
 * contents, so two builds that serve the same files share it and any changed file moves it.
 */
export function buildId(fileNames: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const name of [...fileNames].filter((name) => name.startsWith("assets/")).sort()) hash.update(`${name}\0`);
  return hash.digest("hex").slice(0, 12);
}

const UNLISTED = "const BUILD_FILES = null;";

function stampLine(source: string, line: string, stamped: string): string {
  const at = source.indexOf(line);
  if (at === -1 || source.indexOf(line, at + 1) !== -1) throw new Error(`public/sw.js must hold exactly one \`${line}\` line`);
  return source.replace(line, () => stamped);
}

export function buildFiles(fileNames: Iterable<string>): string[] {
  return [...fileNames]
    .filter((name) => name.startsWith("assets/") && !/\.(woff2?|ttf|br|gz|map)$/.test(name))
    .sort()
    .map((name) => `/${name}`);
}

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

// Vite copies public/ into the out dir before it writes the bundle, so sw.js is stamped in writeBundle.
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
