import type { SessionSnapshot } from "../shared/protocol.ts";
import type { Roster } from "./card-waits.ts";
import { agentProcesses } from "./conversation.ts";
import { readCopilotForeground } from "./copilot-foreground.ts";
import { paneProcessInfo } from "./herdr/client.ts";

type CopilotRoster = Roster & { herdrLifetime(): string | undefined };
type Sample = { readonly processing: boolean; readonly terminal: string; readonly herdr: string };

async function processing(paneId: string): Promise<boolean | undefined> {
  const pid = async () => {
    const front = (await paneProcessInfo(paneId))?.foreground_processes;
    if (!front?.length || front.some((entry) => !entry.argv?.length)) return undefined;
    const candidates = agentProcesses(front, "copilot");
    return candidates.length === 1 && candidates[0]?.argv?.includes("--ui-server") ? candidates[0].pid : undefined;
  };
  const before = await pid();
  if (typeof before !== "number") return undefined;
  const sample = await readCopilotForeground(before, true);
  return sample.state === "selected" && await pid() === before ? sample.processing : undefined;
}

/** A display-only sample: losing a listener or reading `false` is not a successful finish or permission to send. */
export class CopilotActivity {
  private readonly samples = new Map<string, Sample>();
  private readonly reads = new Map<string, object>();
  private stopped = false;
  private cursor = 0;

  constructor(private readonly read = processing) {}

  forget(id: string): void {
    this.samples.delete(id);
    this.reads.delete(id);
  }

  stop(): void {
    this.stopped = true;
    this.samples.clear();
    this.reads.clear();
  }

  apply(snapshot: SessionSnapshot): SessionSnapshot {
    if (!this.samples.size) return snapshot;
    return { ...snapshot, panes: snapshot.panes.map((pane) => {
      const sample = pane.agent === "copilot" ? this.samples.get(pane.pane_id) : undefined;
      return sample && sample.herdr === snapshot.herdr_lifetime && sample.terminal === pane.terminal_id
        ? { ...pane, copilot_processing: sample.processing } : pane;
    }) };
  }

  async tick(roster: CopilotRoster, changed: () => void, watched = true): Promise<void> {
    if (this.stopped || process.platform !== "linux") return;
    const herdr = watched ? roster.herdrLifetime() : undefined;
    if (herdr === undefined) {
      this.samples.clear();
      this.reads.clear();
      return;
    }
    const panes = roster.all().filter((pane) => pane.agent === "copilot");
    const live = new Set(panes.map((pane) => pane.pane_id));
    for (const id of this.samples.keys()) if (!live.has(id)) this.forget(id);
    if (!panes.length) return;
    const batch = Math.min(4 - this.reads.size, panes.length);
    const start = this.cursor;
    this.cursor = (start + batch) % panes.length;
    const changes = await Promise.all(Array.from({ length: batch }, async (_, i) => {
      const { pane_id: id, terminal_id: terminal } = panes[(start + i) % panes.length]!;
      if (this.reads.has(id)) return false;
      const token = {};
      this.reads.set(id, token);
      const lifetime = roster.lifetime(id);
      try {
        const busy = await this.read(id).catch(() => undefined);
        const pane = roster.pane(id);
        if (this.stopped || this.reads.get(id) !== token || lifetime !== roster.lifetime(id)
          || herdr !== roster.herdrLifetime() || pane?.agent !== "copilot" || pane.terminal_id !== terminal) return false;
        const last = this.samples.get(id);
        if (busy === undefined) this.samples.delete(id);
        else this.samples.set(id, { processing: busy, terminal, herdr });
        return busy !== (last?.herdr === herdr && last.terminal === terminal ? last.processing : undefined);
      } finally {
        if (this.reads.get(id) === token) this.reads.delete(id);
      }
    }));
    if (!this.stopped && changes.some(Boolean)) changed();
  }
}
