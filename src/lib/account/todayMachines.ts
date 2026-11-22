/**
 * "My machines" from today's product: the account's directory and this device's pairings (myPcs.ts)
 * and how each saved PC answered this device's own check (pcStatus.ts), with nothing fetched. Read
 * only through machinesSource.ts. The directory does not know the machine's signed list state,
 * engine, or who added it.
 */
import type { Machine, MachinesView, MachineState } from "./machinesView.ts";
import type { MyPc } from "./myPcs.ts";
import type { PcStatus } from "../relay/pcStatus.ts";

/** A check's settled result (answered or offline) with the time this screen first saw it. */
export interface SettledCheck {
  readonly status: Exclude<PcStatus, { kind: "checking" }>;
  readonly at: string;
}

/** What this device knows of one PC's checks: the last settled result, kept through a re-check, and whether one runs now. */
export interface MachineCheck {
  readonly settled: SettledCheck | null;
  readonly checking: boolean;
}

export const NOT_CHECKED: MachineCheck = { settled: null, checking: false };

/**
 * The shell's checks now, folded into what was known: a running check keeps the last settled result,
 * so a re-check never blanks a row; a new result replaces it, at the time the screen first saw it; a PC whose result the shell dropped (an answer older than the directory's idea
 * of recently seen) has none.
 */
export function foldChecks(previous: ReadonlyMap<string, MachineCheck>, status: ReadonlyMap<string, PcStatus>, now: string): Map<string, MachineCheck> {
  const next = new Map<string, MachineCheck>();
  for (const [serverId, current] of status) {
    const before = previous.get(serverId)?.settled ?? null;
    if (current.kind === "checking") next.set(serverId, { settled: before, checking: true });
    else next.set(serverId, { settled: before?.status === current ? before : { status: current, at: now }, checking: false });
  }
  return next;
}

/**
 * A PC's state in "My machines", from its row and this device's checks: the one mapping of today's
 * MyPc state and PcStatus to a Machine state (the gaps note, J).
 */
export function machineStateOf(pc: MyPc, check: MachineCheck): MachineState {
  const offline: MachineState = { kind: "offline", reason: "not-connected", lastSeenAt: pc.last_seen_at };
  // today's PC with no account feature: a paired device still opens it (its own page offers the update), no other gets in
  if (pc.state === "needs-update") return { kind: "needs-update", knowsThisDevice: pc.paired };
  // only paired PCs are checked (pcSweep.ts), and asking to join a PC that is off can only fail
  if (!pc.paired) return pc.state === "offline" ? offline : { kind: "needs-approval", canAsk: pc.join !== undefined };
  const settled = check.settled;
  if (settled !== null) {
    switch (settled.status.kind) {
      case "answered": return { kind: "ready", route: { via: settled.status.route === "relay" ? "relay" : "direct", delayMs: settled.status.rttMs } };
      // this device's own try failed: a new try may work, so the row offers one
      case "offline": return { kind: "unreachable", reason: settled.status.reason === "pc" ? "no-answer" : "relay-unreachable", triedAt: settled.at };
    }
  }
  if (check.checking) return { kind: "unchecked", checking: true, lastSeenAt: pc.last_seen_at };
  return pc.state === "offline" ? offline : { kind: "unchecked", checking: false, lastSeenAt: pc.last_seen_at };
}

function machineOf(pc: MyPc, check: MachineCheck): Machine {
  return {
    id: pc.server_id,
    name: pc.name,
    kind: "pc",
    engine: "not-known",
    state: machineStateOf(pc, check),
    cameIn: { kind: "not-known", listedAt: pc.listed ? pc.added_at : null },
    // every machine of today's list runs the ordinary Ovis server, which serves its own page
    runsOwnOvis: true,
    ...(pc.enrollment === "failed" ? { setupIncomplete: true } : {}),
  };
}

export function todayMachinesView(pcs: readonly MyPc[], checks: ReadonlyMap<string, MachineCheck>): MachinesView {
  return {
    machines: pcs.map((pc) => machineOf(pc, checks.get(pc.server_id) ?? NOT_CHECKED)),
    role: "drive",
  };
}
