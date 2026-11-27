import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { MarkdownDocument, PaneDocuments } from "../shared/files.ts";
import { fileTask } from "./file-pool.ts";
import { gitEnvironment } from "./herdr-core/worktrees.ts";

const CACHE_MS = 5_000;
const MAX_ENTRIES = 5_000;
const MAX_GIT_ENTRIES = 100_000;
const MAX_FOLDER_ENTRIES = 1_000;
const MAX_DEPTH = 6;
const SKIP: Record<string, true> = { ".git": true, node_modules: true, dist: true, target: true, ".venv": true };
const cache = new Map<string, { expires: number; files: string[] }>();

export const GIT_LIST_MAX_BYTES = 16 * 1024 * 1024;
/** How long one git listing may run, including a process it left holding its output. */
export const GIT_LIST_DEADLINE_MS = 3_000;

interface GitListOptions {
  git: string;
  deadlineMs: number;
  maxBytes: number;
}

const GIT_LIST_DEFAULTS: GitListOptions = { git: "git", deadlineMs: GIT_LIST_DEADLINE_MS, maxBytes: GIT_LIST_MAX_BYTES };
let gitList = GIT_LIST_DEFAULTS;

export function setGitListOptions(options: Partial<GitListOptions> = {}): void {
  gitList = { ...GIT_LIST_DEFAULTS, ...options };
}

/** The same policy as `repo-diff.ts`: only read the repository, run no hook or helper, never prompt. */
function gitListArgv(cwd: string): string[] {
  // an empty core.fsmonitor turns the hook off in every git: before 2.36, `false` names a program to run
  return [gitList.git, "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=", "-C", cwd, "ls-files", "-z", "-co", "--exclude-standard"];
}

/** Split only a listing read whole: one whose last name lacks its NUL was cut short, so none of it is used. */
function listedNames(output: Uint8Array): string[] | null {
  if (output.byteLength > 0 && output[output.byteLength - 1] !== 0) return null;
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("utf8").split("\0").filter(Boolean);
}

async function gitFiles(cwd: string, limit = MAX_GIT_ENTRIES): Promise<string[] | null> {
  const { deadlineMs, maxBytes } = gitList;
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(gitListArgv(cwd), { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnvironment() });
  } catch {
    return null;
  }
  const reader = proc.stdout.getReader();
  let stopped = false;
  const stop = () => {
    stopped = true;
    proc.kill("SIGKILL");
    // a process git left behind may still hold stdout after git itself exits
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(stop, deadlineMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        stop();
        break;
      }
      chunks.push(value);
    }
    const exitCode = await proc.exited;
    if (stopped || exitCode !== 0) return null;
    const names = listedNames(Buffer.concat(chunks));
    return names && [...new Set(names)].slice(0, limit);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Breadth first, each folder taking at most its share, so one huge folder cannot use up the walk.
 */
export function walkFiles(cwd: string): string[] {
  return walk(cwd).files;
}

function walk(cwd: string, keep: (name: string) => boolean = () => true, until = Number.POSITIVE_INFINITY): { files: string[]; cut: boolean } {
  const files: string[] = [];
  let visited = 0;
  let cut = false;
  let level = [cwd];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && visited < MAX_ENTRIES; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      if (visited >= MAX_ENTRIES || Date.now() >= until) {
        cut = true;
        break;
      }
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => Number(left.isDirectory()) - Number(right.isDirectory()) || left.name.localeCompare(right.name));
      let taken = 0;
      for (const entry of entries) {
        if (visited >= MAX_ENTRIES) {
          cut = true;
          break;
        }
        if (SKIP[entry.name]) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visited += 1;
          next.push(path);
        } else if (entry.isFile() && keep(entry.name)) {
          if (taken >= MAX_FOLDER_ENTRIES) {
            cut = true;
            continue;
          }
          visited += 1;
          taken += 1;
          files.push(relative(cwd, path).split(sep).join("/"));
        }
      }
    }
    level = next;
  }
  return { files, cut: cut || level.length > 0 };
}

async function inventory(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && hit.expires > Date.now()) return hit.files;
  const files = (await gitFiles(cwd)) ?? await fileTask<string[]>({ op: "walk", cwd });
  files.sort();
  cache.set(cwd, { expires: Date.now() + CACHE_MS, files });
  return files;
}

function subsequence(path: string, query: string): boolean {
  let index = 0;
  for (const character of path) if (character === query[index]) index += 1;
  return index === query.length;
}

function score(path: string, query: string): number {
  if (!query) return 1;
  const lower = path.toLowerCase();
  const original = scoreLower(lower, query);
  if (original >= 0 || !(/[^\x00-\x7f]/.test(path) || /[^\x00-\x7f]/.test(query))) return original;
  return scoreLower(path.normalize("NFC").toLowerCase(), query.normalize("NFC"));
}

function scoreLower(lower: string, query: string): number {
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const at = lower.indexOf(query);
  if (at >= 0) return 300 - at + (name.includes(query) ? 30 : 0);
  if (subsequence(name, query)) return 200 - name.length;
  if (subsequence(lower, query)) return 100 - lower.length / 1000;
  return -1;
}

export async function paneFiles(cwd: string, query = "", limit = 20): Promise<string[]> {
  const normalized = query.trim().toLowerCase();
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 20));
  return (await inventory(cwd))
    .map((path) => ({ path, score: score(path, normalized) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, boundedLimit)
    .map((item) => item.path);
}

const MARKDOWN_NAME = /\.(?:md|markdown)$/i;
export const MAX_MARKDOWN_DOCUMENTS = 500;
export const MARKDOWN_READ_MS = 2_000;

export function readMarkdownDocuments(cwd: string, listed: string[] | null, budgetMs = MARKDOWN_READ_MS): { documents: MarkdownDocument[]; cut: boolean } {
  const until = Date.now() + budgetMs;
  const found = listed === null ? walk(cwd, (name) => MARKDOWN_NAME.test(name), until) : { files: listed, cut: false };
  const documents: MarkdownDocument[] = [];
  let cut = found.cut;
  for (const path of found.files) {
    if (Date.now() >= until) {
      cut = true;
      break;
    }
    try {
      const stat = statSync(join(cwd, path));
      if (stat.isFile()) documents.push({ path, size: stat.size, modified: stat.mtime.toISOString() });
    } catch { }
  }
  return { documents, cut };
}

/**
 * GET /api/pane/docs: the Markdown files under `cwd`, newest first. In a repository, git's listing of
 * the files it does not ignore, asked afresh (Refresh sees a file made a moment ago); elsewhere a walk
 * that counts only Markdown files, so a folder of other files does not crowd them out. Every one is
 * looked at before the newest are kept, and a cap or the read's time limit marks the list cut.
 */
export async function paneDocuments(cwd: string, signal?: AbortSignal): Promise<PaneDocuments> {
  const listed = await gitFiles(cwd, Number.POSITIVE_INFINITY);
  const { documents, cut } = await fileTask<{ documents: MarkdownDocument[]; cut: boolean }>({ op: "documents", cwd, paths: listed === null ? null : listed.filter((path) => MARKDOWN_NAME.test(path)) }, signal);
  documents.sort((left, right) => left.modified === right.modified ? left.path.localeCompare(right.path) : left.modified < right.modified ? 1 : -1);
  return { root: cwd, documents: documents.slice(0, MAX_MARKDOWN_DOCUMENTS), truncated: cut || documents.length > MAX_MARKDOWN_DOCUMENTS };
}

const walked = new Map<string, { expires: number; files: string[] }>();
const listing = new Map<string, Promise<string[]>>();
let generation = 0;

/**
 * The files under `cwd` whose path ends in `name` (a bare `demo.mp4`, or `screenshots/demo.mp4`),
 * for a path an agent wrote without its folders. The git inventory comes first, whole, so a
 * folder of thousands of files cannot hide the one named; the bounded walk follows, since that
 * inventory leaves out ignored files (build output, recordings). The listing is awaited, not
 * waited for: a slow git in a large repository must not hold every other request (#1404).
 */
export async function filesNamed(cwd: string, name: string, limit = 10, anyForm = false): Promise<string[]> {
  const suffix = anyForm ? name.replace(/^\.\//, "").normalize("NFC") : name.replace(/^\.\//, "");
  const hit = walked.get(cwd);
  let files = hit && hit.expires > Date.now() ? hit.files : undefined;
  if (files === undefined) {
    let shared = listing.get(cwd);
    if (shared === undefined) {
      const begun = generation;
      const pending: Promise<string[]> = gitFiles(cwd, Infinity).then(async (listed) => {
        const found = [...new Set([...listed ?? [], ...await fileTask<string[]>({ op: "walk", cwd })])];
        if (begun === generation) {
          walked.set(cwd, { expires: Date.now() + CACHE_MS, files: found });
          if (walked.size > 16) walked.delete(walked.keys().next().value!);
        }
        return found;
      }).finally(() => { if (listing.get(cwd) === pending) listing.delete(cwd); });
      shared = pending;
      listing.set(cwd, pending);
    }
    files = await shared;
  }
  return files.filter((path) => {
    const compared = anyForm ? path.normalize("NFC") : path;
    return compared === suffix || compared.endsWith(`/${suffix}`);
  }).sort().slice(0, limit);
}

export function clearFileCache(): void {
  cache.clear();
  walked.clear();
  listing.clear();
  generation += 1;
}
