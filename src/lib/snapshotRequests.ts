export class SnapshotRequests {
  private revision = 0;

  invalidate(): void { this.revision++; }

  async read<T>(load: () => Promise<T>, commit: (value: T) => void, superseded?: (value: T) => void): Promise<void> {
    const revision = ++this.revision;
    try {
      const value = await load();
      if (revision === this.revision) commit(value);
      else superseded?.(value);
    } catch (error) {
      if (revision === this.revision) throw error;
    }
  }
}
