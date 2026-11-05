/**
 * Whether an agent is on a PATH a pane's shell starts it from, for GET /api/agents. An install that
 * just put the agent in its installer's folder may have added that folder to the login shell's PATH,
 * which the lookup keeps for a while: the folder hit has that PATH read again at once for a new
 * install, then at most every RETRY_MS while it still misses (an installer may edit the shell profile
 * after placing its binary, or a read may fail). Only a PATH hit counts: a folder no PATH has is never
 * offered. Reads that come while a refresh runs wait for it.
 */
export interface PathLookup {
  /** the agent's binary on this server's PATH or the login shell's, as kept */
  onPath(binary: string): Promise<string | null>;
  /** the binary in its installer's folder; `mark` changes with each install (its file's mtime) */
  inInstallFolder(binary: string): { path: string; mark: string } | null;
  /** reads the login shell's PATH again, after any read already out */
  refresh(): Promise<void>;
}

/** How long an install still missing from the PATH waits before the PATH is read again for it. */
export const RETRY_MS = 30_000;

export class InstalledLookup {
  readonly #lookup: PathLookup;
  readonly #now: () => number;
  /** by install: the refresh running for it, or when the last one ended */
  readonly #refreshes = new Map<string, { running: Promise<void> | null; at: number }>();

  constructor(lookup: PathLookup, now: () => number = Date.now) {
    this.#lookup = lookup;
    this.#now = now;
  }

  async has(binary: string): Promise<boolean> {
    const folder = this.#lookup.inInstallFolder(binary);
    const install = folder === null ? null : `${binary}\0${folder.path}\0${folder.mark}`;
    // a refresh running for this install: its answer, not the PATH kept before it
    const running = install === null ? null : this.#refreshes.get(install)?.running ?? null;
    if (running !== null) await running;
    if ((await this.#lookup.onPath(binary)) !== null) return true;
    if (install === null) return false;
    const last = this.#refreshes.get(install);
    if (last !== undefined && (last.running !== null || this.#now() - last.at < RETRY_MS)) {
      if (last.running !== null) await last.running;
      return (await this.#lookup.onPath(binary)) !== null;
    }
    const entry: { running: Promise<void> | null; at: number } = { running: null, at: 0 };
    entry.running = this.#lookup.refresh().catch(() => undefined).finally(() => { entry.running = null; entry.at = this.#now(); });
    this.#refreshes.set(install, entry);
    await entry.running;
    return (await this.#lookup.onPath(binary)) !== null;
  }
}
