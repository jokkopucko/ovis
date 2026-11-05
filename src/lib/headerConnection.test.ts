import { describe, expect, it } from "bun:test";
import { headerConnection, NO_TRACK, stepConnection, type ConnectionFacts, type ConnectionTrack } from "./headerConnection.ts";

const live: ConnectionFacts = { scope: "a:local", reportedBy: "a:local", connected: true, connectedBefore: true, outputStopped: false };

/** The line after each set of facts in turn, as the header renders them. */
function lines(sequence: ConnectionFacts[]): (string | null)[] {
  let track: ConnectionTrack = NO_TRACK;
  return sequence.map((facts) => {
    track = stepConnection(track, facts);
    return headerConnection(facts, track);
  });
}

describe("headerConnection", () => {
  it("says nothing while the PC is connected: the crumb has the line", () => {
    expect(headerConnection(live, NO_TRACK)).toBeNull();
  });

  it("says Reconnecting once a connection this page had is lost", () => {
    expect(headerConnection({ ...live, connected: false }, NO_TRACK)).toBe("reconnecting");
  });

  it("promises no reconnect for output stopped by a stall: nothing retries, the chip says Disconnected", () => {
    expect(headerConnection({ ...live, connected: false, outputStopped: true }, NO_TRACK)).toBeNull();
  });

  it("leaves the first connection to the chip: a pane opening is not a reconnect", () => {
    expect(headerConnection({ ...live, connected: false, connectedBefore: false }, NO_TRACK)).toBeNull();
  });

  it("says Connected while the scope it came back on is the one shown", () => {
    expect(headerConnection(live, { lostOn: null, recoveredOn: "a:local" })).toBe("connected");
    // lost again: reconnecting wins over the last recovery
    expect(headerConnection({ ...live, connected: false }, { lostOn: null, recoveredOn: "a:local" })).toBe("reconnecting");
  });

  it("keeps each PC's recovery to that PC", () => {
    expect(headerConnection({ ...live, scope: "a:devbox", reportedBy: "a:devbox" }, { lostOn: null, recoveredOn: "a:local" })).toBeNull();
  });
});

describe("the line over time", () => {
  it("goes Reconnecting, then Connected, once the same connection is back", () => {
    expect(lines([live, { ...live, connected: false }, live])).toEqual([null, "reconnecting", "connected"]);
  });

  it("does not say Connected after an output stall: that connection was never said to be reconnecting", () => {
    expect(lines([live, { ...live, connected: false, outputStopped: true }, live])).toEqual([null, null, null]);
  });

  it("resets on a switch to another PC: its first connection is not a return", () => {
    const lostHere = { ...live, connected: false };
    // the switch resets the facts before the new PC's terminal reports (useSelection.ts)
    const switched = { ...live, scope: "a:devbox", reportedBy: "a:local", connected: false, connectedBefore: false };
    const devboxUp = { ...live, scope: "a:devbox", reportedBy: "a:devbox" };
    expect(lines([live, lostHere, switched, devboxUp])).toEqual([null, "reconnecting", null, null]);
  });

  it("says Connected the render the connection is back, before the effect moves the track: the crumb never flashes", () => {
    let track = stepConnection(stepConnection(NO_TRACK, live), { ...live, connected: false });
    // the open is rendered with the track the loss left
    expect(headerConnection(live, track)).toBe("connected");
    track = stepConnection(track, live);
    expect(headerConnection(live, track)).toBe("connected");
  });

  it("says nothing for the other split half on one PC that never dropped", () => {
    // half a is lost; half b, on the same PC, is made active: a's facts linger a render before b reports
    const aLost = { ...live, connected: false };
    const bActiveStale = { ...aLost, scope: "b:local" };
    const bReports = { ...live, scope: "b:local", reportedBy: "b:local" };
    expect(lines([live, aLost, bActiveStale, bReports])).toEqual([null, "reconnecting", null, null]);
  });
});
