/** Build in a private checkout. The source tree and the serving build stay intact. */
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CHECKOUT_CHANGED_REASON, noInstalledNotes, readUpdateChannel, type UpdateChannel, noUpdateNotes, unmanagedUpdateStatus, type InstalledNotes, type UpdateCommand, type UpdateNotes, type UpdateStatus } from "../shared/update.ts";
import { compareVersions, releaseNotes, releaseSummaries, SUMMARIES_FILE } from "./release-notes.ts";
import { releaseIn } from "./update-state.ts";

export interface Release {
  directory: string; revision: string; source_revision: string;
  /**
   * The version this release replaced and when, written by the supervisor that installed it.
   * Absent from a release installed by a supervisor older than these fields.
   */
  previous_version?: string | null; installed_at?: string;
}
/** A release's files are read whole: one larger than this is not notes (the bound `runCommand` puts on what Git prints). */
export const NOTES_FILE_LIMIT = 2_000_000;

/**
 * A release's own CHANGELOG.md or release-summaries.json, read from one descriptor: a regular
 * file within NOTES_FILE_LIMIT, or nothing. A file that grows between a look and the read, a
 * symlink, a FIFO or a device would otherwise make the supervisor's synchronous read unbounded.
 */
export function readNotesFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NOTES_FILE_LIMIT) throw new Error(`${path} is not notes`);
    const buffer = Buffer.alloc(NOTES_FILE_LIMIT + 1);
    let read = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, read, buffer.length - read, read);
      if (bytes === 0) break;
      read += bytes;
      if (read > NOTES_FILE_LIMIT) throw new Error(`${path} is too large to be notes`);
    }
    return buffer.toString("utf8", 0, read);
  } finally { closeSync(fd); }
}
const SHA = /^[0-9a-f]{40,64}$/;

/** Shown when the launcher runs from an installed release instead of the checkout it was built from (#1373). */
export const RELEASE_FOLDER_REASON = "This server runs from an installed update's folder, not from its source checkout. Restart Ovis from its source checkout (the herdr plugin's Stop, then Start, or bun run start there) to update.";

/**
 * Whether a directory is a release this updater installed: `<state>/updates/<16 hex>/release-*`
 * (update-state.ts, and `release-` from the install below). Such a release is a detached checkout of
 * a tag, never a source checkout, so the branch guard's "switch to main" would send the user the
 * wrong way.
 */
export function isReleaseFolder(directory: string): boolean {
  const resolved = resolve(directory);
  const parent = dirname(resolved);
  return basename(resolved).startsWith("release-") && /^[0-9a-f]{16}$/.test(basename(parent)) && basename(dirname(parent)) === "updates";
}
/** A release is a plain `vX.Y.Z` tag: `remote-v*` bundle tags and pre-releases never qualify. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/**
 * A beta build CI tagged on green main (.github/workflows/beta.yml): taken only on the beta channel.
 * Outside `v*`, which the installers, the app setups and the release jobs read as releases.
 */
const BETA_TAG = /^beta\/v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
/** A tag's version, without the v: `0.4.23` for `v0.4.23`, `0.4.23-beta.7` for `beta/v0.4.23-beta.7`. */
const tagVersion = (tag: string) => tag.replace(/^(beta\/)?v/, "");

/**
 * The newest tag the channel takes, by version: `v0.4.23` outranks every `beta/v0.4.23-beta.N`, and
 * `beta.10` outranks `beta.9`. On `stable` no beta is ever a candidate.
 */
export function latestTag(tags: string[], channel: UpdateChannel): string | undefined {
  let best: { tag: string; key: number[] } | undefined;
  for (const tag of tags) {
    const release = RELEASE_TAG.exec(tag);
    const match = release ?? (channel === "beta" ? BETA_TAG.exec(tag) : null);
    if (!match) continue;
    // a release sorts after every beta of its version
    const key = [Number(match[1]), Number(match[2]), Number(match[3]), release ? Infinity : Number(match[4])];
    const i = best ? key.findIndex((part, j) => part !== best!.key[j]) : 0;
    if (!best || (i !== -1 && key[i]! > best.key[i]!)) best = { tag, key };
  }
  return best?.tag;
}

/** The name of the setting file in the app's state dir that opts a PC into the beta channel. */
export const UPDATE_CHANNEL_FILE = "update-channel";

/**
 * The channel this PC updates on: `OVIS_UPDATE_CHANNEL` when it names one, else the
 * `update-channel` file in the app's state dir (`beta`), else `stable`. Read at every check, so
 * writing the file takes effect without a restart.
 */
export function updateChannel(env: Record<string, string | undefined>, appStateDir: string): UpdateChannel {
  const set = readUpdateChannel(env["OVIS_UPDATE_CHANNEL"]);
  if (set) return set;
  try { return readUpdateChannel(readFileSync(join(appStateDir, UPDATE_CHANNEL_FILE), "utf8")) ?? "stable"; }
  catch { return "stable"; }
}

function packageVersion(directory: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

/** How long a timed-out or cancelled command has to end itself before it is killed outright. */
const KILL_GRACE_MS = 2_000;

/**
 * Commands use argv, bounded output/time, and a separate group for cancellation. A command that
 * times out or is cancelled is asked to end with SIGTERM and killed only once the grace period
 * has passed: that is what makes git release the lock files it holds (measured on git 2.54, a
 * SIGTERM lifts .git/shallow.lock; a SIGKILL leaves even that, and the next fetch fails with
 * "File exists"). The half-written tmp_pack_* files survive however the fetch ends; removing
 * them after a failed one is the updater's own job (fetchInto) — a slow unshallow fetch
 * leaked 17 GiB of them in three days (#1252).
 */
export function runCommand(cwd: string, argv: string[], signal?: AbortSignal, timeout = 30_000, grace = KILL_GRACE_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    let output = "", errors = "", failure: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
      if (child.pid) { try { process.kill(-child.pid, sig); } catch { child.kill(sig); } }
    };
    const cancel = (reason: string) => {
      failure = reason;
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), grace);
    };
    const abort = () => cancel("Update cancelled");
    const timer = setTimeout(() => cancel(`${argv[0]} timed out`), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", data => { output += data; if (output.length > 2_000_000) cancel("Command output too large"); });
    child.stderr.on("data", data => { errors = (errors + data).slice(-8000); });
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      // a group member that ignores SIGTERM and holds none of our pipes outlives the child: the
      // grace timer cleanup clears would have been its only end
      if (failure !== null) killGroup("SIGKILL");
      cleanup();
      if (code === 0 && !failure) resolve(output.trim());
      else reject(new Error(failure ?? `${argv.slice(0, 3).join(" ")} failed: ${errors.trim() || code}`));
    });
  });
}

/** The unshallow fetch downloads the whole missing history in one go: a slow link needs minutes,
 * not the 30 s bound of an ordinary command (#1252). */
const UNSHALLOW_TIMEOUT_MS = 10 * 60_000;
/** After a failed unshallow fetch, the next attempt waits this long: retried on every 5-minute
 * check, the same history was re-downloaded for days on slow links (#1252). */
const UNSHALLOW_RETRY_MS = 6 * 60 * 60_000;

/** The `tmp_pack_*` files a pack directory holds right now; none when there is no directory. */
function tmpPacks(packDir: string | null): Set<string> {
  if (packDir === null) return new Set();
  try { return new Set(readdirSync(packDir).filter((name) => name.startsWith("tmp_pack_"))); }
  catch { return new Set(); }
}

/** A `tmp_pack_*` untouched this long belongs to no running fetch: index-pack keeps writing to
 * (and so updating the mtime of) the file it fills, and the updater's longest fetch, the
 * unshallow one, is bounded at 10 minutes. */
const STALE_TMP_PACK_MS = 60 * 60_000;

/** Removes the `tmp_pack_*` files that were not there before the fetch: the ones it wrote before
 * failing, never the ones that were already there and none of the directory's other files. A
 * removal that fails is swallowed, not to replace the fetch's own error. */
function cleanTmpPacks(packDir: string | null, before: Set<string>): void {
  if (packDir === null) return;
  for (const name of tmpPacks(packDir)) {
    if (!before.has(name)) { try { rmSync(join(packDir, name), { force: true }); } catch { /* the fetch's error is the one to tell */ } }
  }
}

/** Removes every `tmp_pack_*` file older than STALE_TMP_PACK_MS, whoever left it: the packs a
 * fetch leaked before this cleanup existed (#1252), or that a failed fetch's own cleanup never
 * reached (the process exited first, a crash, a delete Windows refused while the file was
 * open). Best effort and never recursive: a failure or a directory is left alone. */
function sweepStaleTmpPacks(packDir: string | null, now = Date.now()): void {
  if (packDir === null) return;
  for (const name of tmpPacks(packDir)) {
    const path = join(packDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && now - stat.mtimeMs > STALE_TMP_PACK_MS) rmSync(path, { force: true });
    } catch { /* best effort: the next check sweeps again */ }
  }
}

/** A fetch that failed because another git holds a lock in the checkout (a developer's own
 * `git pull` or an IDE's auto-fetch alongside `bun run start`) downloaded nothing; a
 * `tmp_pack_*` that appeared meanwhile is that git's own, still being written. */
function lockConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(".lock': File exists") || message.includes("cannot lock ref");
}

export class Updater {
  readonly controller = new AbortController();
  status: UpdateStatus = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null };
  release: Release | null = null;
  /** What the available update brings; set before the status that offers it is published. */
  notes: UpdateNotes = noUpdateNotes();
  /** What the last update brought; set with the release that runs. */
  installed: InstalledNotes = noInstalledNotes();
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private sourceRevision = "";
  private failedRevision: string | null = null;
  /** When a failed unshallow fetch may be tried again (#1252); a time already past, the initial
   * 0 included, holds nothing off. */
  private unshallowRetryAt = 0;

  constructor(readonly options: {
    root: string; stateDir: string; autoUpdate: boolean;
    /** herdr's `plugin install` checks out a shallow, detached commit it owns; that HEAD is
     * accepted when it is an ancestor of origin/main (a user's own detached checkout is not). */
    pluginCheckout?: boolean;
    /** Runs once a release is installed and active; the supervisor hands itself over here. */
    afterInstall?: (release: Release) => void | Promise<void>;
    /** A standing problem to report in every status (a supervisor that fell back to its predecessor). */
    notice?: string;
    activate: (release: Release, commit: () => void) => Promise<void>;
    publish: (status: UpdateStatus) => void;
    /** The channel to update on, asked at every check (updateChannel); `stable` when not given. */
    channel?: () => UpdateChannel;
  }) {
    this.status.auto_update = options.autoUpdate; this.status.error = options.notice ?? null;
    this.status.channel = this.channel();
  }

  private channel(): UpdateChannel { return this.options.channel?.() ?? "stable"; }

  /** One git command in the source checkout; a test stands in here for a fetch that fails
   * without git ending it itself (#1252). */
  protected git(...args: string[]) { return runCommand(this.options.root, ["git", ...args], this.controller.signal); }
  private patch(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.options.publish(this.status);
  }

  async initialize(): Promise<Release | null> {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    try {
      const failed = JSON.parse(readFileSync(join(this.options.stateDir, "failed.json"), "utf8")) as { revision?: string };
      if (failed.revision && SHA.test(failed.revision)) this.failedRevision = failed.revision;
    } catch { /* no failed automatic candidate */ }
    try {
      this.sourceRevision = await this.git("rev-parse", "HEAD");
      if (!SHA.test(this.sourceRevision)) throw new Error("Invalid source revision");
      this.release = { directory: this.options.root, revision: this.sourceRevision, source_revision: this.sourceRevision };
      const reason = await this.sourceBlock();
      if (!reason) {
        try {
          const saved = JSON.parse(readFileSync(join(this.options.stateDir, "current.json"), "utf8")) as Release;
          // Only directories created by this updater may be resumed, under this state dir's name for them.
          const directory = saved.source_revision === this.sourceRevision && SHA.test(saved.revision)
            ? releaseIn(this.options.stateDir, saved.directory) : null;
          if (directory !== null && await runCommand(directory, ["git", "rev-parse", "HEAD"]) === saved.revision) this.release = { ...saved, directory };
        } catch { /* missing/stale release: use the source checkout */ }
      }
      this.installed = this.brought(this.release);
      this.patch({ current_revision: this.release.revision, current_version: packageVersion(this.release.directory), blocked_reason: reason });
    } catch {
      this.patch({ managed: false, blocked_reason: "Updates require a Git checkout on the main branch." });
    }
    return this.release;
  }

  /**
   * What the update that installed `release` brought: its own changelog and summaries, from the
   * version it replaced. For the source checkout, which no update installed, the answer is that
   * there is none. The replaced version is the one the installing supervisor wrote down; a
   * supervisor older than that record left none, and then it is the newest older build still
   * here, since an install keeps the release it replaces and the source checkout stays.
   */
  private brought(release: Release): InstalledNotes {
    const none = { ...noInstalledNotes(), revision: release.revision };
    if (release.directory === this.options.root) return none;
    const version = packageVersion(release.directory);
    if (!version) return none;
    let previous: string | null = null;
    if (release.installed_at !== undefined) previous = typeof release.previous_version === "string" ? release.previous_version : null;
    else {
      const builds = [this.options.root];
      try {
        for (const entry of readdirSync(this.options.stateDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("release-")) builds.push(join(this.options.stateDir, entry.name));
        }
      } catch { /* the source checkout alone */ }
      for (const directory of builds) {
        const other = directory === release.directory ? null : packageVersion(directory);
        if (!other || !((compareVersions(version, other) ?? 0) > 0)) continue;
        if (previous === null || (compareVersions(other, previous) ?? 0) > 0) previous = other;
      }
    }
    if (previous === null || previous === version) return none;
    let installed_at: string | null = typeof release.installed_at === "string" ? release.installed_at : null;
    if (installed_at === null) {
      try { installed_at = statSync(join(this.options.stateDir, "current.json")).mtime.toISOString(); } catch { /* not told */ }
    }
    const read = (file: string) => readNotesFile(join(release.directory, file));
    let notes: Omit<UpdateNotes, "revision"> = { releases: [], omitted: 0 };
    try {
      const changelog = read("CHANGELOG.md");
      // a release that ships no summaries is told by its changelog alone
      let summaries = "";
      try { summaries = read(SUMMARIES_FILE); } catch { /* none */ }
      notes = releaseNotes(changelog, previous, version, undefined, releaseSummaries(summaries));
    } catch { /* a release without a changelog: the update is told without notes */ }
    return { revision: release.revision, version, previous_version: previous, installed_at, ...notes };
  }

  private async sourceBlock(): Promise<string | null> {
    if (isReleaseFolder(this.options.root)) return RELEASE_FOLDER_REASON;
    const branch = await this.git("branch", "--show-current");
    if (branch !== "main" && !(branch === "" && this.options.pluginCheckout)) return "Switch the source checkout to main to update.";
    if (await this.git("status", "--porcelain", "--untracked-files=all")) return "The source checkout has local changes. Commit or move them before updating.";
    if (await this.git("rev-parse", "HEAD") !== this.sourceRevision) return CHECKOUT_CHANGED_REASON;
    return null;
  }

  start() {
    // One check per supervisor, independent of tabs. No network calls in createServer tests.
    this.initialTimer = setTimeout(() => void this.request("check"), 10_000);
    this.timer = setInterval(() => void this.request("check"), 5 * 60_000);
  }
  stop() {
    clearTimeout(this.initialTimer); clearInterval(this.timer); this.controller.abort();
  }

  private async discover(byUser = false) {
    const channel = this.channel();
    this.patch({ phase: "checking", error: this.options.notice ?? null, error_code: null, available: false, blocked_reason: null, channel });
    const reason = await this.sourceBlock();
    if (reason) { this.patch({ blocked_reason: reason, checked_at: new Date().toISOString() }); return; }
    // Only published releases update installs: commits pushed to main without a tag stay put. The
    // beta channel also takes the beta tags CI makes on green main.
    const betas = channel === "beta" ? ["+refs/tags/beta/*:refs/tags/beta/*"] : [];
    await this.fetchInto(() => this.git("fetch", "--no-tags", "origin", "+refs/tags/v*:refs/tags/v*", ...betas));
    const tags = (await this.git("for-each-ref", "--format=%(refname:short)", "refs/tags/v*", "refs/tags/beta/")).split("\n");
    const checked_at = new Date().toISOString();
    const latest = latestTag(tags, channel);
    if (!latest) {
      this.notes = noUpdateNotes();
      this.patch({ latest_revision: null, latest_version: null, checked_at, blocked_reason: null, available: false });
      return;
    }
    // ^{commit} peels an annotated tag to the commit the build and the health check report
    const target = await this.git("rev-parse", `${latest}^{commit}`);
    if (!SHA.test(target)) throw new Error("Invalid update revision");
    const current = this.release!.revision;
    let block: string | null = null;
    let available = false;
    if (target !== current) {
      if (await this.ancestor(current, target, byUser)) available = true;
      // running ahead of the latest release (a development checkout) is simply up to date
      else if (!await this.ancestor(target, current, byUser)) {
        block = "The running version is not part of the release history; automatic downgrade is disabled.";
      }
    }
    // the notes of the last check stay readable while this one runs; they change with its answer
    // a beta is told by the releases up to its base version: its own changes have no section yet
    this.notes = available ? await this.changes(target, tagVersion(latest).replace(/-beta\.\d+$/, "")) : noUpdateNotes();
    this.patch({ latest_revision: target, latest_version: tagVersion(latest), checked_at, blocked_reason: block, available });
  }

  /**
   * The release's own CHANGELOG.md, as fetched with its tag: never the checkout's, which is older,
   * and never main's, whose unreleased entries the install does not bring. A release without one
   * (or with one that cannot be read) is offered without notes.
   */
  private async changes(revision: string, version: string): Promise<UpdateNotes> {
    try {
      const changelog = await this.git("show", `${revision}:CHANGELOG.md`);
      // a release older than the summaries has no such file: its notes are told as they are
      const summaries = await this.git("show", `${revision}:${SUMMARIES_FILE}`).catch(() => "");
      return { revision, ...releaseNotes(changelog, this.status.current_version, version, undefined, releaseSummaries(summaries)) };
    } catch { return { ...noUpdateNotes(), revision }; }
  }

  /** herdr's plugin checkout is shallow: fetch the missing history once before calling two commits unrelated. */
  private async ancestor(older: string, newer: string, byUser = false): Promise<boolean> {
    const test = () => this.git("merge-base", "--is-ancestor", older, newer).then(() => true, () => false);
    if (await test()) return true;
    if (await this.git("rev-parse", "--is-shallow-repository") !== "true") return false;
    // the backoff holds the timer off, never a user's own Check or Update — the same way a
    // revision automatic installation gave up on is still installed when asked for
    if (!byUser && Date.now() < this.unshallowRetryAt) {
      throw new Error(`The checkout's history is not fully fetched; the unshallow fetch failed and the next attempt is at ${new Date(this.unshallowRetryAt).toISOString()}.`);
    }
    try { await this.fetchInto(() => this.unshallowFetch(UNSHALLOW_TIMEOUT_MS)); }
    catch (error) {
      this.unshallowRetryAt = Date.now() + UNSHALLOW_RETRY_MS;
      throw error;
    }
    return test();
  }

  /** The checkout's pack directory, where a killed fetch leaves its half-written packs; null
   * when the root is not a Git checkout whose directory could be named. */
  private async packDir(): Promise<string | null> {
    const dir = await this.git("rev-parse", "--git-common-dir").catch(() => null);
    return dir === null ? null : join(resolve(this.options.root, dir), "objects", "pack");
  }

  /** Every fetch into the checkout goes through here, the tag fetch of each check and the
   * one-off unshallow fetch alike: a failed fetch leaves its half-written tmp_pack_* files
   * behind however it ends (measured on git 2.54: SIGTERM, SIGINT, SIGKILL, and git's own
   * exit after the connection dropped), so what it added to the pack directory is removed
   * here, on every OS — Windows cannot signal a process group at all, and any kill path can
   * be too late anyway (#1252). */
  private async fetchInto(fetch: () => Promise<string>): Promise<string> {
    const packDir = await this.packDir();
    sweepStaleTmpPacks(packDir);
    const held = tmpPacks(packDir);
    try { return await fetch(); }
    catch (error) {
      // another git's lock: its in-progress pack is not ours to remove; anything it abandons is
      // swept once stale
      if (!lockConflict(error)) cleanTmpPacks(packDir, held);
      throw error;
    }
  }

  /** The one-off fetch of the missing history, with its own, much longer timeout (#1252);
   * `run` is the command runner, a seam for a test that checks the argv and timeout the real
   * fetch hands on. */
  protected async unshallowFetch(timeout: number, run: typeof runCommand = runCommand): Promise<string> {
    return run(this.options.root, ["git", "fetch", "--no-tags", "--unshallow", "origin"], this.controller.signal, timeout);
  }

  /** `byUser`: the request came from the settings' Check or Update (through the supervisor), not
   * from the 5-minute timer; only the timer waits a failed unshallow fetch's backoff out.
   * `expectedRevision`: the release a manual install was offered; the install goes ahead only
   * while the check it starts with still offers exactly that one. */
  async request(command: UpdateCommand, byUser = false, expectedRevision?: string): Promise<void> {
    if (this.busy || !this.status.managed || this.controller.signal.aborted) return;
    this.busy = true;
    let stage: string | null = null;
    let attempted: string | null = null;
    try {
      await this.discover(byUser);
      // a release published since the person said yes is not the one they said yes to: nothing is
      // installed, the new offer stays to be read, and nothing tries again by itself
      // (a blocked checkout says why itself, and installs nothing either)
      if (command === "install" && expectedRevision !== undefined && !this.status.blocked_reason && this.status.latest_revision !== expectedRevision) {
        this.patch({ phase: "error", step: null, error_code: "update_offer_changed",
          error: "A different release is on offer than the one asked for, so nothing was installed. Review it, then update again." });
        return;
      }
      if ((command === "install" || this.options.autoUpdate) && this.status.available) {
        const revision = this.status.latest_revision!;
        if (command === "check" && revision === this.failedRevision) {
          this.patch({ phase: "error", error: "Automatic installation of this revision previously failed. Use Update and restart to retry, or wait for a newer revision." });
          return;
        }
        attempted = revision;
        this.patch({ phase: "building", step: "download" });
        stage = mkdtempSync(join(this.options.stateDir, "release-"));
        // Network filesystems and low-memory builds can take minutes even without a network fetch.
        const run = (args: string[], timeout = 10 * 60_000) => runCommand(stage!, args, this.controller.signal, timeout);
        await run(["git", "clone", "--quiet", "--no-checkout", "--no-hardlinks", this.options.root, "."]);
        await run(["git", "fetch", "--quiet", this.options.root, revision]);
        await run(["git", "checkout", "--quiet", "--detach", revision]);
        // The clone's origin must keep pointing at the user's chosen upstream.
        await run(["git", "remote", "set-url", "origin", await this.git("remote", "get-url", "origin")]);
        this.patch({ step: "dependencies" });
        await run([process.execPath, "install", "--frozen-lockfile"]);
        this.patch({ step: "typecheck" });
        // --bun: tsc's `#!/usr/bin/env node` would otherwise run on whatever node herdr's PATH has first, which
        // may be older than tsc supports now that install.sh no longer puts its own Node there (#596)
        await run([process.execPath, "--bun", "run", "typecheck"]);
        this.patch({ step: "build" });
        await run([process.execPath, "run", "build"]);
        // the release's Rust PTY host, checked against its manifest; without it the release runs the Node sidecar
        if (existsSync(join(stage, "scripts", "pty-sidecar.ts"))) {
          try { console.log((await run([process.execPath, "scripts/pty-sidecar.ts", "install"], 120_000))); }
          catch (error) { console.error("Rust PTY host install failed; the release uses the Node PTY sidecar", error); }
        }
        const reason = await this.sourceBlock();
        if (reason) throw new Error(reason);
        this.controller.signal.throwIfAborted();
        const previous = this.release;
        // what it replaces, on record for the supervisor the release starts: that one was not here for the install
        const next: Release = { directory: stage, revision, source_revision: this.sourceRevision,
          previous_version: previous ? packageVersion(previous.directory) : null, installed_at: new Date().toISOString() };
        this.patch({ phase: "restarting", step: "restart" });
        await this.options.activate(next, () => {
          const file = join(this.options.stateDir, "current.json");
          writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
          renameSync(`${file}.tmp`, file);
        });
        this.release = next;
        stage = null;
        this.notes = noUpdateNotes();
        // a supervisor that stays (one run directly, without the launcher) tells it from here on
        this.installed = this.brought(next);
        this.patch({ current_revision: revision, current_version: packageVersion(next.directory), available: false });
        this.failedRevision = null;
        rmSync(join(this.options.stateDir, "failed.json"), { force: true });
        // every release held here is named under this state dir (initialize names a resumed one so), so a
        // name kept is a directory kept, even where the release was recorded under another spelling (#2029)
        for (const entry of readdirSync(this.options.stateDir, { withFileTypes: true })) {
          const directory = join(this.options.stateDir, entry.name);
          if (entry.isDirectory() && entry.name.startsWith("release-") && directory !== next.directory && directory !== previous?.directory) {
            rmSync(directory, { recursive: true, force: true });
          }
        }
        // before "idle": a supervisor that hands over exits here, so "idle" with the new revision
        // only ever comes from the supervisor that will keep running it
        try { await this.options.afterInstall?.(next); }
        catch (error) { console.error("afterInstall failed", error); }
      }
      this.patch({ phase: "idle", step: null });
    } catch (error) {
      if (attempted && !this.controller.signal.aborted) {
        this.failedRevision = attempted;
        try {
          writeFileSync(join(this.options.stateDir, "failed.json"), JSON.stringify({ revision: attempted }), { mode: 0o600 });
        } catch { /* the in-memory guard still prevents repeated automatic restarts */ }
      }
      this.patch({ phase: "error", step: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      this.busy = false;
    }
  }
}
