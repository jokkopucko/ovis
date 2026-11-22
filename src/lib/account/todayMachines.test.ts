import { describe, expect, test } from "bun:test";
import type { MachineState } from "./machinesView.ts";
import type { MyPc, MyPcState } from "./myPcs.ts";
import type { PcStatus } from "../relay/pcStatus.ts";
import { foldChecks, machineStateOf, NOT_CHECKED, todayMachinesView, type MachineCheck } from "./todayMachines.ts";

const ID = "0123456789abcdef0123456789abcdef";
const SEEN = "2026-11-14T10:00:00.000Z";
const ADDED = "2026-11-01T09:00:00.000Z";
const TRIED = "2026-11-14T10:05:00.000Z";
const LATER = "2026-11-14T10:06:00.000Z";
const JOIN = { server_public_key: "a2V5", relay: "wss://relay.test" };

function pc(state: MyPcState, paired: boolean, extra: Partial<MyPc> = {}): MyPc {
  return { server_id: ID, name: "m1-box", state, last_seen_at: SEEN, added_at: ADDED, listed: true, paired, linked: paired, ...extra };
}

/** The check a row sees after the shell held `status` alone: a settled result, a first check under way, or none. */
function checkOf(status: PcStatus | null): MachineCheck {
  return status === null ? NOT_CHECKED : foldChecks(new Map(), new Map([[ID, status]]), TRIED).get(ID)!;
}

const ANSWERED_RELAY: PcStatus = { kind: "answered", route: "relay", relay: "wss://relay.test", rttMs: 41 };
const CHECKS: readonly (readonly [string, PcStatus | null])[] = [
  ["none", null],
  ["checking", { kind: "checking" }],
  ["answered relay", ANSWERED_RELAY],
  ["answered lan", { kind: "answered", route: "lan", rttMs: 3 }],
  ["answered tailscale", { kind: "answered", route: "tailscale", rttMs: 9 }],
  ["offline pc", { kind: "offline", reason: "pc" }],
  ["offline relay", { kind: "offline", reason: "relay" }],
];

const offline: MachineState = { kind: "offline", reason: "not-connected", lastSeenAt: SEEN };
const unreachable: MachineState = { kind: "unreachable", reason: "relay-unreachable", triedAt: TRIED };
/** this device's own check found no answer: a new try may work, and the row offers one */
const noAnswer: MachineState = { kind: "unreachable", reason: "no-answer", triedAt: TRIED };
const update = (knowsThisDevice: boolean): MachineState => ({ kind: "needs-update", knowsThisDevice });
const checking: MachineState = { kind: "unchecked", checking: true, lastSeenAt: SEEN };
const ready = (via: "relay" | "direct", delayMs: number): MachineState => ({ kind: "ready", route: { via, delayMs } });

/** What a paired PC shows for each check, by its MyPc state: the table of the gaps note, J. */
const PAIRED: Record<"paired" | "offline" | "needs-update", Record<string, MachineState>> = {
  paired: {
    none: { kind: "unchecked", checking: false, lastSeenAt: SEEN },
    checking,
    "answered relay": ready("relay", 41), "answered lan": ready("direct", 3), "answered tailscale": ready("direct", 9),
    "offline pc": noAnswer,
    "offline relay": unreachable,
  },
  offline: {
    none: offline,
    // a first check under way says Checking…, whatever the directory says
    checking,
    "answered relay": ready("relay", 41), "answered lan": ready("direct", 3), "answered tailscale": ready("direct", 9),
    "offline pc": noAnswer,
    "offline relay": unreachable,
  },
  // a paired device is one today's outdated PC knows: it still opens it, whatever the check says
  "needs-update": Object.fromEntries(CHECKS.map(([name]) => [name, update(true)])),
};

describe("machineStateOf: a paired PC's state, for every check", () => {
  for (const [myState, byCheck] of Object.entries(PAIRED) as [keyof typeof PAIRED, Record<string, MachineState>][]) {
    for (const [name, status] of CHECKS) {
      test(`${myState} with ${name}`, () => {
        expect(machineStateOf(pc(myState, true), checkOf(status))).toEqual(byCheck[name]!);
      });
    }
  }
});

describe("machineStateOf: a PC this device is not paired with ignores any check", () => {
  for (const [name, status] of CHECKS) {
    test(`needs-approval, ${name}`, () => {
      expect(machineStateOf(pc("needs-approval", false, { join: JOIN }), checkOf(status))).toEqual({ kind: "needs-approval", canAsk: true });
      expect(machineStateOf(pc("needs-approval", false), checkOf(status))).toEqual({ kind: "needs-approval", canAsk: false });
    });
    test(`offline, ${name}`, () => {
      expect(machineStateOf(pc("offline", false, { join: JOIN }), checkOf(status))).toEqual(offline);
    });
    test(`needs-update, ${name}`, () => {
      expect(machineStateOf(pc("needs-update", false), checkOf(status))).toEqual(update(false));
    });
  }
});

describe("foldChecks: a re-check keeps the last settled state until its result arrives", () => {
  const row = pc("paired", true);
  const after = (...steps: PcStatus[]): MachineCheck => {
    let known = new Map<string, MachineCheck>();
    steps.forEach((status, index) => { known = foldChecks(known, new Map([[ID, status]]), index === 0 ? TRIED : LATER); });
    return known.get(ID)!;
  };
  for (const [name, settled, state] of [
    ["ready", ANSWERED_RELAY, ready("relay", 41)],
    ["no answer", { kind: "offline", reason: "pc" }, noAnswer],
    ["unreachable", { kind: "offline", reason: "relay" }, unreachable],
  ] as const) {
    test(`${name} stays while the next check runs`, () => {
      expect(machineStateOf(row, after(settled, { kind: "checking" }))).toEqual(state);
    });
  }
  test("the new result replaces it, with the time it arrived", () => {
    expect(machineStateOf(row, after(ANSWERED_RELAY, { kind: "checking" }, { kind: "offline", reason: "relay" })))
      .toEqual({ kind: "unreachable", reason: "relay-unreachable", triedAt: LATER });
  });
  test("an unchanged result keeps the time it first arrived", () => {
    const status: PcStatus = { kind: "offline", reason: "relay" };
    const first = foldChecks(new Map(), new Map([[ID, status]]), TRIED);
    expect(foldChecks(first, new Map([[ID, status]]), LATER).get(ID)?.settled?.at).toBe(TRIED);
  });
  test("a result the shell dropped is not kept", () => {
    const first = foldChecks(new Map(), new Map([[ID, ANSWERED_RELAY]]), TRIED);
    expect(foldChecks(first, new Map(), LATER).has(ID)).toBe(false);
  });
});

describe("todayMachinesView: what today's data does not know", () => {
  test("who added a machine is not known; when the account listed it is, for a listed one", () => {
    const view = todayMachinesView([pc("paired", true), pc("paired", true, { server_id: "f".repeat(32), listed: false, added_at: null, last_seen_at: null })], new Map());
    expect(view.machines.map((machine) => machine.cameIn)).toEqual([{ kind: "not-known", listedAt: ADDED }, { kind: "not-known", listedAt: null }]);
  });

  test("every entry is a PC with an engine the source does not learn", () => {
    const [machine] = todayMachinesView([pc("paired", true)], new Map()).machines;
    expect(machine).toMatchObject({ id: ID, name: "m1-box", kind: "pc", engine: "not-known", runsOwnOvis: true });
    // today has no signed list: a machine's own list state is not known
    expect(machine && "list" in machine).toBe(false);
  });

  test("an enrolment that failed marks the machine; one that did not leaves no mark", () => {
    const view = todayMachinesView([pc("paired", true, { enrollment: "failed" }), pc("paired", true, { server_id: "e".repeat(32), enrollment: "complete" })], new Map());
    expect(view.machines.map((machine) => machine.setupIncomplete)).toEqual([true, undefined]);
  });

  test("an empty directory still gives a driving device an empty list", () => {
    expect(todayMachinesView([], new Map())).toEqual({ machines: [], role: "drive" });
  });
});

test("a failed check by this device offers a new try whatever the directory saw since: it is this device's own word", () => {
  for (const reason of ["pc", "relay"] as const) {
    const failed = checkOf({ kind: "offline", reason });
    expect(machineStateOf(pc("paired", true, { last_seen_at: LATER }), failed).kind).toBe("unreachable");
  }
});
