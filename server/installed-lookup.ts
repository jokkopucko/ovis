export interface PathLookup {
  onPath(binary: string): Promise<string | null>;
  inInstallFolder(binary: string): { path: string; mark: string } | null;
  refresh(interactive: boolean): Promise<void>;
}

export const RETRY_MS = 30_000;

export class InstalledLookup {
  readonly #lookup: PathLookup;
  readonly #now: () => number;
  readonly #refreshes = new Map<string, { running: Promise<void> | null; at: number }>();

  constructor(lookup: PathLookup, now: () => number = Date.now) {
    this.#lookup = lookup;
    this.#now = now;
  }

  async has(binary: string): Promise<boolean> {
    const folder = this.#lookup.inInstallFolder(binary);
    const install = folder === null ? null : `${binary}\0${folder.path}\0${folder.mark}`;
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
    // the interactive shell (which runs the user's .zshrc) is asked again for a new install only, not on each retry
    entry.running = this.#lookup.refresh(last === undefined).catch(() => undefined).finally(() => { entry.running = null; entry.at = this.#now(); });
    this.#refreshes.set(install, entry);
    await entry.running;
    return (await this.#lookup.onPath(binary)) !== null;
  }
}
