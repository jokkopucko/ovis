import { describe, expect, it } from "bun:test";

import { OWN_UPDATE_OFFER, type Machine, type RemoteOvis } from "../../shared/machines.ts";
import { ownOvisAction, ownUpdateFailure, pcListExit } from "./MachineSidebar.tsx";

const offer = (updatable: boolean): RemoteOvis => ({ version: "0.4.16", latest_version: updatable ? "0.4.18" : null, updatable, reason: updatable ? null : "it cannot", address: "pc.invalid:4000", url: null });
const pc = (patch: Partial<Pick<Machine, "remote_ovis" | "action_required" | "error">>) => ({ remote_ovis: null, action_required: null, error: null, ...patch });

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
    // an offer the PC no longer waits for is told the usual way (#2054)
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
    // a refusal is the setup card's reason, not a failed update offered again
    expect(ownUpdateFailure(pc({ remote_ovis: offer(false), action_required: "setup", error: failed }))).toBeNull();
  });
});
