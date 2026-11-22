import { invitationEndsAt, newPcs, type MyPc, type MyPcState } from "../account/myPcs.ts";
import type { PcStatus } from "./pcStatus.ts";
import { REGIONAL_RELAYS } from "../../../shared/relay-regions.ts";

export type DashboardPc = MyPc & { relay: string | null };
/** `unreachable`: this device's own check reached no relay, so it knows nothing of the PC itself (Could not reach this machine) */
export type DashboardState = MyPcState | "unchecked" | "unreachable";

/** What this device's own last finished check says of a paired PC (a re-check in flight keeps it), or null while none has finished. */
function checkedState(check: PcStatus | null): "paired" | "offline" | "unreachable" | null {
  if (check === null) return null;
  switch (check.kind) {
    case "checking": return checkedState(check.previous ?? null);
    case "answered": return "paired";
    case "offline": return check.reason === "pc" ? "offline" : "unreachable";
  }
}

export function dashboardState(pc: Pick<MyPc, "state" | "listed">, check: PcStatus | null): DashboardState {
  const checked = checkedState(check);
  switch (pc.state) {
    case "needs-approval": case "needs-update": return pc.state;
    // the account confirmed it has not heard from it (accountController ages no row past its last answer): only an answer beats that
    case "offline": return checked === "paired" ? "paired" : "offline";
    case "paired": return checked ?? (pc.listed ? "paired" : "unchecked");
  }
}

export type AttentionReason = Exclude<DashboardState, "paired" | "unchecked">;

export type DashboardFilter = "all" | "ready" | "needs" | "offline";

/**
 * Needs you: whatever the owner has to act on, an approval, an update, a PC gone offline or one this device could not
 * reach. It overlaps Offline on purpose, so the counts are never added up as a partition.
 */
function needsYou(state: DashboardState): state is AttentionReason {
  switch (state) {
    case "needs-approval": case "needs-update": case "offline": case "unreachable": return true;
    case "paired": case "unchecked": return false;
  }
}

export function inDashboardFilter(state: DashboardState, filter: DashboardFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "ready": return state === "paired";
    case "needs": return needsYou(state);
    case "offline": return state === "offline";
  }
}

const TABLE_GROUP: Record<DashboardState, number> = { "needs-approval": 0, "needs-update": 0, offline: 1, unreachable: 1, paired: 2, unchecked: 2 };

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenId = (a: MyPc, b: MyPc): number => a.name.localeCompare(b.name) || byId(a.server_id, b.server_id);
const byTableOrder = (a: MyPc & { displayState: DashboardState }, b: MyPc & { displayState: DashboardState }): number =>
  TABLE_GROUP[a.displayState] - TABLE_GROUP[b.displayState] || byNameThenId(a, b);

export function dashboardPcs(pcs: readonly MyPc[], saved: readonly { server_id: string; relay: string }[], directory: readonly { server_id: string; relay: string | null }[] = []): DashboardPc[] {
  const listed = new Map(directory.map((pc) => [pc.server_id, pc.relay]));
  const paired = new Map(saved.map((device) => [device.server_id, device.relay]));
  return pcs.map((pc) => ({ ...pc, relay: listed.get(pc.server_id) ?? pc.join?.relay ?? paired.get(pc.server_id) ?? null }));
}

export function relayHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

export interface DashboardViewer {
  readonly label: string;
  readonly now?: number;
  readonly status?: ReadonlyMap<string, PcStatus>;
}

const ATTENTION_RANK: Record<AttentionReason, number> = { "needs-update": 1, "needs-approval": 2, unreachable: 3, offline: 4 };

/**
 * `displayState` reconciles them once: a live answer beats stale Offline, while an unlisted
 * pairing without an answer remains unchecked. Pairing membership still controls access.
 */
export function dashboardModel(pcs: readonly DashboardPc[], me: DashboardViewer, defaultRelay: string) {
  const now = me.now ?? Date.now();
  const expiries = new Map(newPcs(pcs, now).map((pc) => [pc.server_id, invitationEndsAt(pc)]));
  const rows = pcs.map((pc) => {
    const check = (pc.paired ? me.status?.get(pc.server_id) : undefined) ?? null;
    return {
      ...pc,
      displayState: dashboardState(pc, check),
      origin: pc.relay ?? defaultRelay,
      source: pc.listed ? "directory" as const : "this-device" as const,
      check,
    };
  }).sort(byTableOrder);

  const ids = (filter: DashboardFilter): string[] => rows.filter((pc) => inDashboardFilter(pc.displayState, filter)).map((pc) => pc.server_id);
  const filters: Record<DashboardFilter, readonly string[]> = { all: ids("all"), ready: ids("ready"), needs: ids("needs"), offline: ids("offline") };

  const attention = rows
    .flatMap((pc) => { const reason = pc.displayState; return needsYou(reason) ? [{ pc, reason, expiresAt: expiries.get(pc.server_id) ?? null }] : []; })
    .sort((a, b) => (a.expiresAt === null ? ATTENTION_RANK[a.reason] : 0) - (b.expiresAt === null ? ATTENTION_RANK[b.reason] : 0)
      || (a.expiresAt ?? 0) - (b.expiresAt ?? 0)
      || byNameThenId(a.pc, b.pc))
    .map(({ pc, reason, expiresAt }) => ({ server_id: pc.server_id, reason, expiresAt }));

  const hubs = new Map<string, typeof rows>();
  for (const row of rows) hubs.set(row.origin, [...(hubs.get(row.origin) ?? []), row]);
  const busiestFirst = [...hubs].sort(([a, pcsA], [b, pcsB]) => pcsB.length - pcsA.length || a.localeCompare(b));

  return {
    counts: { ready: filters.ready.length, needsYou: filters.needs.length, offline: filters.offline.length, paired: rows.filter((pc) => pc.paired).length },
    filters,
    rows,
    attention,
    relays: busiestFirst.map(([origin, members]) => ({ origin, regional: REGIONAL_RELAYS.includes(origin), pcs: members.map((pc) => pc.server_id) })),
    map: {
      me: { label: me.label },
      hubs: busiestFirst.map(([origin, members]) => ({
        origin,
        nodes: members.map((pc) => ({
          server_id: pc.server_id,
          name: pc.name,
          state: pc.displayState,
          last_seen_at: pc.last_seen_at,
          seen: pc.state === "offline" ? "stale" as const
            : pc.state === "paired" && pc.last_seen_at !== null ? "lately" as const : "unknown" as const,
          check: pc.check,
        })),
      })),
    },
  };
}
