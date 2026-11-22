import { describe, expect, it } from "bun:test";
import { forgetSessionHistoryProbe, forgetSessionHistoryProbesOfPcsAway, sharedSessionHistoryProbe } from "./useSessionHistoryOffered.ts";

describe("sharedSessionHistoryProbe", () => {
  it("asks a PC once for every pane and menu that wants the answer", async () => {
    let asked = 0;
    const ask = async () => { asked++; return true; };
    const answers = await Promise.all([1, 2, 3].map(() => sharedSessionHistoryProbe("pc-shared", ask)));
    expect(answers).toEqual([true, true, true]);
    expect(await sharedSessionHistoryProbe("pc-shared", ask)).toBe(true);
    expect(asked).toBe(1);
    forgetSessionHistoryProbe("pc-shared");
  });
  it("asks a PC again once the PCs' own states showed it away, with nothing of it mounted", async () => {
    let asked = 0;
    const ask = async () => { asked++; return true; };
    expect(await sharedSessionHistoryProbe("pc-away", ask)).toBe(true);
    forgetSessionHistoryProbesOfPcsAway([{ id: "pc-away", state: "connected" }]);
    expect(await sharedSessionHistoryProbe("pc-away", ask)).toBe(true);
    expect(asked).toBe(1);
    forgetSessionHistoryProbesOfPcsAway([{ id: "pc-away", state: "disconnected" }]);
    forgetSessionHistoryProbesOfPcsAway([{ id: "pc-away", state: "connected" }]);
    expect(await sharedSessionHistoryProbe("pc-away", ask)).toBe(true);
    expect(asked).toBe(2);
    forgetSessionHistoryProbesOfPcsAway([]);
    expect(await sharedSessionHistoryProbe("pc-away", ask)).toBe(true);
    expect(asked).toBe(3);
    forgetSessionHistoryProbe("pc-away");
  });
  it("keeps a PC's probe while one of its panes reconnects: only the PC's own state forgets it", async () => {
    let asked = 0;
    const ask = async () => { asked++; return true; };
    expect(await sharedSessionHistoryProbe("pc-pane", ask)).toBe(true);
    for (let n = 0; n < 3; n++) forgetSessionHistoryProbesOfPcsAway([{ id: "pc-pane", state: "connected" }]);
    expect(await sharedSessionHistoryProbe("pc-pane", ask)).toBe(true);
    expect(asked).toBe(1);
    forgetSessionHistoryProbesOfPcsAway([{ id: "pc-pane", state: "reconnecting" }]);
    forgetSessionHistoryProbesOfPcsAway([{ id: "pc-pane", state: "connected" }]);
    expect(await sharedSessionHistoryProbe("pc-pane", ask)).toBe(true);
    expect(asked).toBe(2);
    forgetSessionHistoryProbe("pc-pane");
  });
  it("asks again once the PC went away, and after a probe that failed", async () => {
    let asked = 0;
    const missing = async () => { asked++; return false; };
    expect(await sharedSessionHistoryProbe("pc-again", missing)).toBe(false);
    forgetSessionHistoryProbe("pc-again");
    expect(await sharedSessionHistoryProbe("pc-again", missing)).toBe(false);
    expect(asked).toBe(2);
    forgetSessionHistoryProbe("pc-again");
    const failing = async (): Promise<boolean> => { asked++; throw new Error("the PC did not answer"); };
    await expect(sharedSessionHistoryProbe("pc-failing", failing)).rejects.toThrow("the PC did not answer");
    expect(await sharedSessionHistoryProbe("pc-failing", missing)).toBe(false);
    expect(asked).toBe(4);
    forgetSessionHistoryProbe("pc-failing");
  });
});
