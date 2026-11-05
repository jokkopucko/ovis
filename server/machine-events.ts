/** The authorized machine event document, shared by SSE and the terminal WebSocket. */
import type { DevicePairedEvent, Machine, MachineEvent } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { SeenFinish } from "../shared/seen.ts";
import type { MachineManager } from "./machines.ts";
import { decidedRowTokens, reportedTokenValues, snapshotWithoutHiddenTokens, withoutHiddenTokens } from "./herdr-sidebar.ts";

export interface MachineEventDocument {
  manager: Pick<MachineManager, "subscribe">;
  preferences?: { get(): SharedPreferences; subscribe(listener: (preferences: SharedPreferences) => void): () => void };
  herdrSidebar?: { get(): AgentRowTokens | null; subscribe(listener: (agents: AgentRowTokens | null) => void): () => void };
  seen?: { list(): SeenFinish[]; subscribe(listener: (finish: SeenFinish) => void): () => void };
  /** Filtered for the authenticated device and browser at the transport's admission boundary. */
  pairings?: { subscribe(listener: (event: DevicePairedEvent) => void): () => void };
}

/** Initial documents and subsequent invalidations use exactly the same redaction on either transport. */
export function subscribeMachineEvents({ manager, preferences, herdrSidebar, seen, pairings }: MachineEventDocument, send: (event: MachineEvent) => void): () => void {
  const stops: Array<() => void> = [];
  let active = true;
  const tell = (event: MachineEvent) => { if (active) send(event); };
  const stop = () => { active = false; for (const off of stops.splice(0)) off(); };
  try {
    let rows = herdrSidebar?.get() ?? null;
    let reported = new Map<string, Set<string>>();
    let roster: Machine[] | undefined;
    let toldSidebar: string | undefined;
    const sendSidebar = (...values: Map<string, Set<string>>[]) => {
      if (!herdrSidebar) return;
      const event = { type: "herdr-sidebar", agents: decidedRowTokens(rows, ...values) } satisfies MachineEvent;
      const encoded = JSON.stringify(event);
      if (encoded === toldSidebar) return;
      toldSidebar = encoded;
      tell(event);
    };
    const sendRoster = (machines: Machine[]) => {
      roster = machines;
      const shown = withoutHiddenTokens(rows, machines);
      const incoming = reportedTokenValues(shown);
      sendSidebar(reported, incoming);
      reported = incoming;
      tell({ type: "machines", machines: shown });
    };
    stops.push(manager.subscribe((event) => {
      if (event.type === "machines") { sendRoster(event.machines); return; }
      tell(event.type === "machine-message" && event.message.type === "snapshot"
        ? { ...event, message: { ...event.message, snapshot: snapshotWithoutHiddenTokens(rows, event.message.snapshot) } }
        : event);
    }));
    const sendPreferences = (shared: SharedPreferences) => tell({ type: "preferences", preferences: shared });
    if (preferences) {
      stops.push(preferences.subscribe(sendPreferences));
      sendPreferences(preferences.get());
    }
    sendSidebar(reported);
    if (herdrSidebar) stops.push(herdrSidebar.subscribe((next) => { rows = next; if (roster) sendRoster(roster); else sendSidebar(reported); }));
    if (seen) {
      tell({ type: "seen", finishes: seen.list() });
      stops.push(seen.subscribe((finish) => tell({ type: "seen", finishes: [finish] })));
    }
    if (pairings) stops.push(pairings.subscribe(tell));
    return stop;
  } catch (error) { stop(); throw error; }
}
