import { describe, expect, it } from "bun:test";

import { OWN_UPDATE_OFFER, type Machine, type RemoteOvis } from "../../shared/machines.ts";
import { ADD_PC_FROM_KEY, addPcExit, collapsedKey, machineAway, openAddPc, manageActions, ownOvisAction, ownUpdateFailure, pcListExit, removablePc } from "./MachineSidebar.tsx";

const offer = (updatable: boolean): RemoteOvis => ({ version: "0.4.16", latest_version: updatable ? "0.4.18" : null, updatable, reason: updatable ? null : "it cannot", address: "pc.invalid:4000", url: null });
const pc = (patch: Partial<Pick<Machine, "remote_ovis" | "action_required" | "error">>) => ({ remote_ovis: null, action_required: null, error: null, ...patch });

describe("where a phone's More → Add a PC leads", () => {
  const pcPage = `/s/${"a".repeat(32)}/`;
  it("keeps a hosted PC page in the hosted app, also inside the phone app; sends a PC the app opened by its address back to the app; offers none elsewhere", () => {
    expect(addPcExit({ nativeApp: false, relayShell: true, pathname: pcPage })).toBe("shell");
    expect(addPcExit({ nativeApp: true, relayShell: true, pathname: pcPage })).toBe("shell");
    expect(addPcExit({ nativeApp: true, relayShell: false, pathname: "/" })).toBe("app");
    expect(addPcExit({ nativeApp: false, relayShell: false, pathname: "/" })).toBeNull();
    expect(addPcExit({ nativeApp: false, relayShell: true, pathname: "/" })).toBeNull();
  });

  it("opens the hosted app's Add a PC marking the PC page it came from, for its Back", () => {
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const key of ["window", "sessionStorage"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const store = new Map<string, string>();
    const went: string[] = [];
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: pcPage, assign: (url: string) => { went.push(url); } } } });
    try {
      openAddPc("shell");
      expect(went).toEqual(["/#add"]);
      expect(store.get(ADD_PC_FROM_KEY)).toBe(pcPage);
    } finally {
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
});

describe("the way back to a phone's list of PCs", () => {
  const pcPage = `/s/${"ab".repeat(16)}/`;
  it("goes to the phone app's own list in the app, a relay PC's page there included", () => {
    expect(pcListExit({ nativeApp: true, relayShell: true, pathname: pcPage })).toBe("app");
    expect(pcListExit({ nativeApp: true, relayShell: false, pathname: "/" })).toBe("app");
  });

  it("goes to the hosted shell's front page from a PC's page there, and is absent in a PC's own app", () => {
    expect(pcListExit({ nativeApp: false, relayShell: true, pathname: pcPage })).toBe("shell");
    expect(pcListExit({ nativeApp: false, relayShell: true, pathname: "/" })).toBeNull();
    expect(pcListExit({ nativeApp: false, relayShell: false, pathname: pcPage })).toBeNull();
  });
});

describe("a PC's own Ovis on its card", () => {
  it("is offered only as what the PC waits for: its update, or a setup it cannot run itself", () => {
    expect(ownOvisAction(pc({ remote_ovis: offer(true), action_required: "update_bridge" }))).toEqual(offer(true));
    expect(ownOvisAction(pc({ remote_ovis: offer(false), action_required: "setup" }))).toEqual(offer(false));
    expect(ownOvisAction(pc({ remote_ovis: offer(true), action_required: "setup" }))).toBeNull();
    expect(ownOvisAction(pc({ remote_ovis: offer(false), action_required: "update_bridge" }))).toBeNull();
    expect(ownOvisAction(pc({ remote_ovis: offer(true), action_required: "bridge_conflict" }))).toBeNull();
    expect(ownOvisAction(pc({ remote_ovis: null, action_required: "update_bridge" }))).toBeNull();
  });

  it("tells why its last update failed, never the offer's own sentence", () => {
    const failed = "That PC's Ovis could not update itself: disk full";
    expect(ownUpdateFailure(pc({ remote_ovis: offer(true), action_required: "update_bridge", error: failed }))).toBe(failed);
    expect(ownUpdateFailure(pc({ remote_ovis: offer(true), action_required: "update_bridge", error: `${OWN_UPDATE_OFFER} to v0.4.18.` }))).toBeNull();
    expect(ownUpdateFailure(pc({ remote_ovis: offer(true), action_required: "update_bridge" }))).toBeNull();
    expect(ownUpdateFailure(pc({ remote_ovis: offer(false), action_required: "setup", error: failed }))).toBeNull();
  });
});

describe("a PC that does not answer", () => {
  type Away = Parameters<typeof machineAway>[0];
  const failing = (kind: Away["kind"], error: string, patch: Partial<Away> = {}): Away => ({ kind, enabled: true, state: "reconnecting", error, action_required: null, updating: undefined, herdr_profile_id: undefined, ...patch });

  it("is off when the relay had nobody for it, and out of reach when ssh could not reach it", () => {
    expect(machineAway(failing("relay", "The PC did not answer through the relay"))).toBe("off");
    for (const error of ["ssh: connect to host pc port 22: Connection refused", "ssh: connect to host pc port 22: Operation timed out", "ssh: connect to host pc port 22: No route to host"]) expect(machineAway(failing("ssh", error))).toBe("unreachable");
  });

  it("is out of reach when the relay itself did not answer, or turned this server away", () => {
    expect(machineAway(failing("relay", "The relay could not be reached"))).toBe("unreachable");
    expect(machineAway(failing("relay", "The relay connection failed (1006)"))).toBe("unreachable");
    expect(machineAway(failing("relay", "Relay carrier lost during admission"))).toBe("unreachable");
    expect(machineAway(failing("relay", "The relay turned this device away (1013)"))).toBe("refused");
  });

  it("is not off when it answered: a relay PC that did not finish connecting, an SSH timeout after ssh connected", () => {
    expect(machineAway(failing("relay", "The PC did not finish the connection (auth)"))).toBe("unresponsive");
    expect(machineAway(failing("ssh", "SSH port forward timed out"))).toBeNull();
  });

  it("waits for the next try's words when a connection was only lost, which does not say which side went", () => {
    expect(machineAway(failing("relay", "Relay connection to this PC was lost"))).toBeNull();
  });

  it("is not offered a re-check while connected, turned off here, refused for good, or waiting on a person", () => {
    const off = "The PC did not answer through the relay";
    expect(machineAway(failing("relay", off, { state: "connected" }))).toBeNull();
    expect(machineAway(failing("relay", off, { state: "error" }))).toBeNull();
    expect(machineAway(failing("relay", off, { enabled: false }))).toBeNull();
    expect(machineAway(failing("relay", off, { action_required: "update_bridge" }))).toBeNull();
    expect(machineAway(failing("relay", "That PC removed this PC's access. Add it again with a new pairing link."))).toBeNull();
    expect(machineAway(failing("ssh", "pc: Permission denied (publickey)."))).toBeNull();
    expect(machineAway(failing("ssh", "ssh: connect to host pc port 22: Connection refused", { herdr_profile_id: "p1" }))).toBeNull();
    expect(machineAway(failing("hc", "This machine's server connection was lost"))).toBeNull();
  });
});

describe("Remove in Settings", () => {
  it("offers it for a PC added here over SSH, through the relay or by its address once it is not connected", () => {
    const removable = (kind: Machine["kind"], state: Machine["state"] = "error", herdr_profile_id?: string) => removablePc({ kind, state, herdr_profile_id });
    expect(["ssh", "relay", "address"].map((kind) => removable(kind as Machine["kind"]))).toEqual([true, true, true]);
    expect([removable("address", "connected"), removable("ssh", "disconnected", "p1"), removable("hc"), removable("local")]).toEqual([false, false, false, false]);
  });
});

describe("Manage PC's menu", () => {
  type Managed = Parameters<typeof manageActions>[0];
  const ssh = (patch: Partial<Managed> = {}): Managed => ({ kind: "ssh", herdr_profile_id: undefined, enabled: true, target: { destination: "pc.invalid" }, action_required: null, ...patch });
  const ids = (machine: Managed, busy = false, canHide = true) => manageActions(machine, { busy, canHide }).map(({ id }) => id);
  const waiting = (machine: Managed, busy = false, canHide = true) => manageActions(machine, { busy, canHide }).filter(({ disabled }) => disabled).map(({ id }) => id);

  it("offers every action for a PC added here, Remove PC last", () => {
    expect(ids(ssh())).toEqual(["rename", "toggle", "setup", "update", "hide", "remove"]);
    expect(waiting(ssh())).toEqual([]);
  });

  it("offers no SSH setup or bridge update for a PC reached through the relay or by its address", () => {
    expect(ids(ssh({ kind: "relay", target: undefined }))).toEqual(["rename", "toggle", "hide", "remove"]);
    expect(ids(ssh({ kind: "address", target: undefined }))).toEqual(["rename", "toggle", "hide", "remove"]);
  });

  it("keeps herdr's limits for a PC herdr manages: no rename, disconnect or removal here", () => {
    expect(ids(ssh({ herdr_profile_id: "profile" }))).toEqual(["setup", "update", "hide"]);
  });

  it("offers only Hide on this device for a machine of herdr-core, which hc machine and the Herdr app manage", () => {
    expect(ids(ssh({ kind: "hc", target: undefined }))).toEqual(["hide"]);
    expect(ids(ssh({ kind: "hc", target: undefined }), false, false)).toEqual([]);
  });

  it("leaves Hide on this device out while the PC is the last one shown", () => {
    expect(ids(ssh(), false, false)).toEqual(["rename", "toggle", "setup", "update", "remove"]);
  });

  it("keeps setup and the bridge update to the PC's own notice when that is what it waits for", () => {
    expect(ids(ssh({ action_required: "setup" }))).toEqual(["rename", "toggle", "update", "hide", "remove"]);
    expect(ids(ssh({ action_required: "connect" }))).toEqual(["rename", "toggle", "hide", "remove"]);
    expect(ids(ssh({ action_required: "update_bridge" }))).toEqual(["rename", "toggle", "setup", "update", "hide", "remove"]);
  });

  it("holds setup and the bridge update for a disabled PC, or one with no address", () => {
    expect(waiting(ssh({ enabled: false }))).toEqual(["setup", "update"]);
    expect(waiting(ssh({ target: undefined }))).toEqual(["setup", "update"]);
  });

  it("holds a rename, a connect or disconnect, Hide and a removal while one of them runs", () => {
    expect(waiting(ssh(), true)).toEqual(["rename", "toggle", "hide", "remove"]);
    expect(waiting(ssh({ kind: "hc", target: undefined }), true)).toEqual(["hide"]);
  });
});

it("keeps each hosted PC page's folded header apart, as every PC there names its own machine local", () => {
  const page = (id: string) => ({ relayShell: true, pathname: `/s/${id.repeat(32)}/` });
  expect(collapsedKey("local", page("a"))).not.toBe(collapsedKey("local", page("b")));
  expect(collapsedKey("local", { relayShell: false, pathname: "/" })).toBe("ovis:pc-collapsed:local");
});
