import type { AgentInfo, PaneInfo, SessionSnapshot } from "./protocol.ts";
import type { Machine, MachineEvent } from "./machines.ts";

// Fixed v1 contract: adding inherited fields requires a new negotiation/version, for cached clients.
const SHARED_FIELDS = [
  "terminal_id", "agent", "terminal_title", "terminal_title_stripped", "agent_status", "agent_session",
  "workspace_id", "tab_id", "focused", "cwd", "foreground_cwd", "revision", "title", "display_agent", "tokens", "state_labels",
] as const satisfies readonly (keyof AgentInfo & keyof PaneInfo)[];
type SharedField = typeof SHARED_FIELDS[number];
type AgentRef = Partial<AgentInfo> & Pick<AgentInfo, "pane_id"> & { _omit?: SharedField[] };
export type CompactSnapshot = Omit<SessionSnapshot, "agents"> & { agent_refs: AgentRef[] };
export type WireMachine = Omit<Machine, "snapshot"> & { snapshot: SessionSnapshot | CompactSnapshot | null };
type SnapshotEvent = Extract<MachineEvent, { type: "machine-message" }>;
export type WireMachineEvent = MachineEvent
  | { type: "machines"; machines: WireMachine[] }
  | (Omit<SnapshotEvent, "message"> & { message: Omit<Extract<SnapshotEvent["message"], { type: "snapshot" }>, "snapshot"> & { snapshot: SessionSnapshot | CompactSnapshot } });

export class CompactAgentsError extends Error {
  override name = "CompactAgentsError";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A row that names its pane, with no key a plain object would read as its prototype. */
const namedRow = (row: unknown): row is { pane_id: string } =>
  isRecord(row) && typeof row.pane_id === "string" && !Object.hasOwn(row, "__proto__") && !Object.hasOwn(row, "constructor");

const REFS_KEY_EXTRA = "agent_refs".length - "agents".length;

const ownOmit = (row: unknown): row is Record<string, unknown> => isRecord(row) && Object.hasOwn(row, "_omit");

/**
 * `agent_refs` and a row's `_omit` are this server's alone: those a PC put in its own snapshot are removed
 * before any wire form, or the decoder would read them as the encoder's.
 */
function withoutCompactMarkers(snapshot: SessionSnapshot): SessionSnapshot {
  const { agents }: { agents: unknown } = snapshot;
  const omitted = Array.isArray(agents) && agents.some(ownOmit);
  if (!Object.hasOwn(snapshot, "agent_refs") && !omitted) return snapshot;
  const { agent_refs: _foreign, ...full } = snapshot as SessionSnapshot & { agent_refs?: unknown };
  if (!omitted) return full;
  return { ...full, agents: full.agents.map((agent: unknown) => {
    if (!ownOmit(agent)) return agent;
    const { _omit: _foreignOmit, ...row } = agent;
    return row;
  }) as AgentInfo[] };
}

/** Only equal values are inherited. Conflicts, agent-only fields, array order and absent fields survive. */
export function compactSnapshot(received: SessionSnapshot): SessionSnapshot | CompactSnapshot {
  const snapshot = withoutCompactMarkers(received);
  const { panes: paneList, agents }: { panes: unknown; agents: unknown } = snapshot;
  if (!Array.isArray(paneList) || !Array.isArray(agents) || !paneList.every(isRecord)) return snapshot;
  const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  if (!agents.every((agent) => namedRow(agent) && panes.has(agent.pane_id))) return snapshot;
  let saved = false;
  const refs = snapshot.agents.map((agent): AgentRef => {
    const pane = panes.get(agent.pane_id)!;
    const ref: AgentRef = { ...agent };
    const omit: SharedField[] = [];
    for (const key of SHARED_FIELDS) {
      if (!Object.hasOwn(pane, key)) continue;
      if (!Object.hasOwn(agent, key) || agent[key] === undefined) { omit.push(key); delete ref[key]; }
      else if (JSON.stringify(agent[key]) === JSON.stringify(pane[key])) { delete ref[key]; saved = true; }
    }
    if (omit.length) ref._omit = omit;
    return ref;
  });
  if (!saved || JSON.stringify(refs).length + REFS_KEY_EXTRA >= JSON.stringify(snapshot.agents).length) return snapshot;
  const { agents: _agents, ...rest } = snapshot;
  return { ...rest, agent_refs: refs };
}

/** Expands only the encoder's own form, its marker without full rows: a snapshot carrying both is full. */
export function expandSnapshot(snapshot: SessionSnapshot | CompactSnapshot): SessionSnapshot {
  if (Object.hasOwn(snapshot, "agents") || !Object.hasOwn(snapshot, "agent_refs")) return withoutCompactMarkers(snapshot as SessionSnapshot);
  const { agent_refs: refs, ...rest } = snapshot as CompactSnapshot;
  const { panes: paneList }: { panes: unknown } = snapshot;
  if (!Array.isArray(paneList) || !paneList.every(isRecord) || !Array.isArray(refs)) throw new CompactAgentsError("compact snapshot without panes or agent_refs");
  const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const agents = refs.map((ref: unknown): AgentInfo => {
    if (!namedRow(ref) || !panes.has(ref.pane_id)) throw new CompactAgentsError("agent_refs row names no pane of its snapshot");
    const { _omit: omit, ...overrides } = ref as AgentRef;
    if (omit !== undefined && !(Array.isArray(omit) && omit.every((key) => typeof key === "string"))) throw new CompactAgentsError("_omit is not a list of field names");
    const pane = panes.get(ref.pane_id)!;
    const inherited = Object.fromEntries(SHARED_FIELDS.filter((key) => Object.hasOwn(pane, key) && !omit?.includes(key)).map((key) => [key, pane[key]]));
    return { ...inherited, ...overrides } as AgentInfo;
  });
  return { ...rest, agents };
}

/** A machine as a client takes it: compact when it asked, and never with a PC's own marker. */
export function wireMachine(machine: Machine, compact: false): Machine;
export function wireMachine(machine: Machine, compact: boolean): WireMachine;
export function wireMachine(machine: Machine, compact: boolean): WireMachine {
  if (!machine.snapshot) return machine;
  return { ...machine, snapshot: compact ? compactSnapshot(machine.snapshot) : withoutCompactMarkers(machine.snapshot) };
}

export function expandMachine(machine: WireMachine): Machine {
  return machine.snapshot ? { ...machine, snapshot: expandSnapshot(machine.snapshot) } : machine as Machine;
}

/** A machine event as a client takes it: compact when it asked, and never with a PC's own marker. */
export function wireMachineEvent(event: MachineEvent, compact: boolean): WireMachineEvent {
  if (event.type === "machines") return { ...event, machines: event.machines.map((machine) => wireMachine(machine, compact)) };
  if (event.type === "machine-message" && event.message.type === "snapshot") {
    const { snapshot } = event.message;
    return { ...event, message: { ...event.message, snapshot: compact ? compactSnapshot(snapshot) : withoutCompactMarkers(snapshot) } };
  }
  return event;
}

export function expandMachineEvent(event: WireMachineEvent): MachineEvent {
  if (event.type === "machines") return { ...event, machines: event.machines.map(expandMachine) };
  if (event.type === "machine-message" && event.message.type === "snapshot") {
    return { ...event, message: { ...event.message, snapshot: expandSnapshot(event.message.snapshot) } };
  }
  return event as MachineEvent;
}
