/** Where app state and managed-update state live. Dependency-free on purpose: the launcher
 * (server/managed.ts) imports it and must stay small and stable across releases. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type SupervisorRelease = { readonly root: string; readonly port: number; readonly directory: string };

export function defaultStateDir(env: Record<string, string | undefined> = process.env, supervisor?: SupervisorRelease): string {
  const override = env["OVIS_STATE_DIR"];
  if (override) return override;
  // The launcher chose this supervisor from its active release record. Keep that record's
  // state even when the bridge registry recreated the old name beside it after launcher start.
  if (supervisor) {
    const directory = resolve(supervisor.directory);
    const stateDir = resolve(directory, "../../..");
    if (basename(directory).startsWith("release-") && dirname(directory) === updateStateDir(supervisor.root, supervisor.port, stateDir)) {
      // Bun runs a script from its real path, so a release reached through a symlinked $HOME or
      // ~/.config is found under the real one here, where the launcher and the source checkout's
      // supervisor name it through the link. The launcher's name is kept: a launcher from before
      // this fix takes only a release recorded under its own (#2029).
      const { legacy, next } = stateDirNames(env);
      return [next, legacy].find((dir) => sameDir(dir, stateDir)) ?? stateDir;
    }
  }
  const { legacy, next } = stateDirNames(env);
  return currentStateDir(legacy, next);
}

/**
 * The release `directory` names when it is one of the update state dir `stateDir`'s
 * (`<stateDir>/release-*`), named under `stateDir`; null when it is not. The two are compared by real
 * path, since one may be spelled through a symlink and the other not (#2029). Only an absolute path
 * with no `.` or `..` segment qualifies: the real path of `<stateDir>/link/../release-x` drops the
 * `..` first, where a process started there follows the link first and runs somewhere else. The
 * name returned is the one to check and run, so both reach the directory that was compared.
 */
export function releaseIn(stateDir: string, directory: string): string | null {
  if (!isAbsolute(directory) || resolve(directory) !== directory) return null;
  try {
    const release = realpathSync(directory);
    return basename(release).startsWith("release-") && dirname(release) === realpathSync(stateDir) ? join(stateDir, basename(release)) : null;
  } catch { return null; }
}

/** The default state dir under its name from before the rename, and under its new one. */
export function stateDirNames(env: Record<string, string | undefined>): { legacy: string; next: string } {
  const config = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return { legacy: join(config, "herdr-web-ui"), next: join(config, "ovis") };
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * The bridge registry (bridge.ts) is kept under the old name for older remote bundles, and every
 * bridge start creates it there again. It is never app state.
 */
const BRIDGE_REGISTRY = "bridges";
/**
 * What the merge of the two dirs (state-merge.ts) writes into the old one while it is not linked:
 * copies of the new dir's files, which are not state of the old dir's own while they are the same
 * bytes, and the backups of what it replaced, which move along.
 */
const MERGE_COPIES = ["devices.json", "preferences.json", "muted-panes.json", "preferences-id.json", "state-merge.json", "state-merge-devices-incomplete.json"];
const MERGE_BACKUPS = "state-merge-backups";

const sameFile = (left: string, right: string): boolean => {
  try { return readFileSync(left).equals(readFileSync(right)); } catch { return false; }
};

/** An entry of the old dir that is not state of its own: the registry, the merge's backups, or an unchanged copy. */
const linkable = (legacy: string, next: string, entry: string): boolean =>
  entry === BRIDGE_REGISTRY || entry === MERGE_BACKUPS || MERGE_COPIES.includes(entry) && sameFile(join(legacy, entry), join(next, entry));

/**
 * What the dir under its name from before the rename holds, when it is not the new dir itself:
 * "state", "registry" (the bridge registry alone) or null (nothing of its own).
 */
function legacyContents(legacy: string, next: string): "state" | "registry" | null {
  try {
    if (!isDir(legacy)) return null;
    const entries = readdirSync(legacy);
    if (entries.length === 0 || isDir(next) && realpathSync(legacy) === realpathSync(next)) return null;
    return entries.every((entry) => linkable(legacy, next, entry)) ? "registry" : "state";
  } catch (error) {
    // ENOENT: another process of this install is moving it right now. An old dir this process
    // cannot read is not one it can use; the new one then reports what it cannot write.
    if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** The dir under its name from before the rename, when it still holds state of its own. */
function holdsOwnState(legacy: string, next: string): boolean {
  return legacyContents(legacy, next) === "state";
}

/**
 * Where the state is now; moves nothing. The old dir wins while it holds state of its own: the
 * bridge registry alone is not, or a fresh install would leave its state at its first restart.
 */
export function currentStateDir(legacy: string, next: string): string {
  return holdsOwnState(legacy, next) ? legacy : next;
}

/**
 * A launcher from before 0.4.16 takes an old dir that is not empty for the state, the bridge
 * registry alone included, and an update never replaces a running launcher, nor the one its
 * checkout starts next. So where the old name holds only the registry beside a new dir, the
 * registry moves into the new dir (in one rename: a remote bridge keeps its own state inside it)
 * and the old name becomes a link to the new dir, where those launchers then find the state.
 *
 * The link is made first, under another name, so that where no link can be made nothing moves.
 * A bridge that runs writes its state under the old name by path, so the move waits until no
 * bridge registered there runs. A step that fails leaves the rest for the next start; the old dir
 * meanwhile gets a closed copy of the paired devices from every server start (state-merge.ts).
 */
export function linkLegacyRegistry(legacy: string, next: string): void {
  finishInterruptedLink(legacy, next);
  if (legacyContents(legacy, next) !== "registry" || !isDir(next)) return;
  try { if (lstatSync(legacy).isSymbolicLink()) return; } catch { return; }
  const from = join(legacy, BRIDGE_REGISTRY);
  const to = join(next, BRIDGE_REGISTRY);
  if (liveBridge(from)) return;
  const link = `${legacy}.link-${process.pid}`;
  removeLink(link);
  try { symlinkSync(next, link, "junction"); }
  catch (error) {
    console.error(`cannot link ${legacy} to ${next}, so it stays a dir of its own, with a closed copy of the paired devices: ${(error as Error).message}`);
    return;
  }
  try {
    if (!existsSync(from)) { /* only the merge's files */ }
    else if (!existsSync(to)) renameSync(from, to);
    else moveInto(from, to);
    for (const entry of readdirSync(legacy)) {
      const source = join(legacy, entry);
      if (entry === MERGE_BACKUPS) {
        if (!existsSync(join(next, MERGE_BACKUPS))) renameSync(source, join(next, MERGE_BACKUPS));
        else moveInto(source, join(next, MERGE_BACKUPS));
      } else if (MERGE_COPIES.includes(entry) && sameFile(source, join(next, entry))) unlinkSync(source);
    }
    try { rmdirSync(legacy); }
    catch (error) {
      // a writer put something back under the old name in between: it joins the new dir, once
      if (!existsSync(from) || !["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      moveInto(from, to);
      rmdirSync(legacy);
    }
  } catch (error) {
    removeLink(link);
    // ENOENT: another process of this install moved it first, and links it
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`cannot link ${legacy} to ${next}, so it stays a dir of its own, with a closed copy of the paired devices; what moved is in ${to}: ${(error as Error).message}`);
    return;
  }
  try { renameSync(link, legacy); }
  catch (error) {
    removeLink(link);
    // a bridge registered under the old name in between: the next start moves it and links
    if (["EEXIST", "ENOTEMPTY", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    // The old name must not be left free: a bridge would make it again with its registry alone, where
    // a launcher from before 0.4.16 starts ungated. Empty, those launchers pass it by, and the merge
    // leaves its closed copy of the devices in it (state-merge.ts).
    try { mkdirSync(legacy, { mode: 0o700 }); } catch { /* reported below */ }
    console.error(`moved the bridge registry into ${next} but cannot link ${legacy} to it, so it stays a dir of its own, with a closed copy of the paired devices: ${(error as Error).message}`);
  }
}

/**
 * A link that a process made under another name and stopped before it took the old name (a crash):
 * where the old name is free, the link takes it now. Other such links are left over, and go.
 */
function finishInterruptedLink(legacy: string, next: string): void {
  const prefix = `${basename(legacy)}.link-`;
  let leftovers: string[];
  try { leftovers = readdirSync(dirname(legacy)).filter((entry) => entry.startsWith(prefix)).map((entry) => join(dirname(legacy), entry)); }
  catch { return; }
  for (const link of leftovers) {
    let pointsAtNext = false;
    try { pointsAtNext = lstatSync(link).isSymbolicLink() && sameDir(link, next); } catch { /* gone */ }
    // another process of this install may be making its own right now: only a dead one's is left over
    if (link === `${legacy}.link-${process.pid}` || livePid(Number(link.slice(link.lastIndexOf("-") + 1)))) continue;
    if (pointsAtNext && !existsSync(legacy)) {
      try { renameSync(link, legacy); continue; }
      catch (error) {
        // the name must not stay free (as in linkLegacyRegistry): empty, older launchers pass it by,
        // and the merge leaves its closed copy of the devices in it
        try { mkdirSync(legacy, { mode: 0o700 }); }
        catch {
          // the link stays, for the next start to try again
          console.error(`cannot finish linking ${legacy} to ${next}, and cannot make it again: ${(error as Error).message}`);
          continue;
        }
        console.error(`cannot finish linking ${legacy} to ${next}, so it stays a dir of its own, with a closed copy of the paired devices: ${(error as Error).message}`);
      }
    }
    removeLink(link);
  }
}

const sameDir = (left: string, right: string): boolean => {
  if (resolve(left) === resolve(right)) return true;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
};

/** Whether a bridge registered in `registry` may still run: a descriptor names a live process other than this one. */
function liveBridge(registry: string): boolean {
  let entries: string[];
  try { entries = readdirSync(registry); } catch { return false; }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let pid: unknown;
    try { pid = (JSON.parse(readFileSync(join(registry, entry), "utf8")) as { pid?: unknown }).pid; } catch { continue; }
    if (typeof pid !== "number" || pid === process.pid) continue;
    if (livePid(pid)) return true;
  }
  return false;
}

/** Whether `pid` names a running process (one of another user's counts). */
function livePid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Moves every entry of `from` into `to`, then removes `from`. Where both hold an entry, the one under
 * `from` is the current one (bridges register, and a running bridge writes, under the old name):
 * a file replaces the other, and two dirs merge the same way.
 */
function moveInto(from: string, to: string): void {
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (!existsSync(target)) renameSync(source, target);
    else if (lstatSync(source).isDirectory() && lstatSync(target).isDirectory()) moveInto(source, target);
    else if (!lstatSync(source).isDirectory() && !lstatSync(target).isDirectory()) renameSync(source, target);
    // a file and a dir of one name stay as they are, and so does the old dir: the error says so
  }
  rmdirSync(from);
}

/** Removes a link this code made, where it is; a junction on Windows is removed as a dir. */
function removeLink(path: string): void {
  try { unlinkSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    try { rmdirSync(path); } catch { /* left for the next start */ }
  }
}

let moved = false;

/**
 * Moves the state dir from before the rename to its new name, once per process. Only the
 * processes that own the state call it (launcher, supervisor, server), before they read it;
 * anything else, a test included, only resolves where the state is (defaultStateDir).
 */
export function moveLegacyStateDir(env: Record<string, string | undefined> = process.env, supervisor?: SupervisorRelease): void {
  if (moved) return;
  const { legacy, next } = stateDirNames(env);
  // a process told to use one of the two default dirs links them too (an older launcher finds the
  // state through the old name); one told to use a dir apart from them leaves them alone
  const told = env["OVIS_STATE_DIR"];
  if (!told || [legacy, next].some((dir) => sameDir(told, dir))) linkLegacyRegistry(legacy, next);
  if (told) return;
  if (supervisor && defaultStateDir(env, supervisor) !== defaultStateDir(env)) return;
  moved = true;
  adoptLegacyDir(legacy, next);
}

/**
 * Moves `legacy` to `next` and leaves a link at the old name for a launcher, plugin or older
 * release that still uses it. A link at `legacy` moves as a link, so state kept elsewhere stays
 * there. Where the move fails, or `next` already holds other files, the old dir stays in use;
 * an old dir that holds only the bridge registry then joins the new one (linkLegacyRegistry).
 */
export function adoptLegacyDir(legacy: string, next: string): void {
  const contents = legacyContents(legacy, next);
  if (contents === null) return;
  // the registry alone beside a new dir with files: the registry joins it
  if (contents === "registry" && isDir(next) && readdirSync(next).length > 0) return linkLegacyRegistry(legacy, next);
  try {
    // an empty dir at the new name gives way; one with files of its own stays
    if (isDir(next)) rmdirSync(next);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: another process of this install removed it first, and the move goes on
    if (code !== "ENOENT") {
      if (holdsOwnState(legacy, next)) console.error(code === "ENOTEMPTY" || code === "EEXIST"
        ? `both ${legacy} and ${next} hold files, so the state in ${legacy} stays in use; move what you keep into one of them`
        : `cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
      return;
    }
  }
  try {
    renameSync(legacy, next);
  } catch (error) {
    // another process of this install moved it first
    if (legacyContents(legacy, next) === null) return;
    console.error(`cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
    return;
  }
  try {
    // "junction" needs no privilege on Windows; other platforms ignore the type
    symlinkSync(next, legacy, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    console.error(`moved ${legacy} to ${next} but cannot link the old name to it: ${(error as Error).message}`);
  }
}

/** One update state per source checkout and port, so two checkouts or ports never share builds. */
export function updateStateDir(root: string, port: number, stateDir = defaultStateDir()): string {
  return join(resolve(stateDir), "updates",
    createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
}

/** A supervisor exits with this after an install: "start the supervisor of the release now active"
 * (EX_TEMPFAIL, never a crash code). */
export const HANDOVER_EXIT = 75;
