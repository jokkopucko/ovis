import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awakeLabel, holdAwake, readAwakeSettings, readWorking, writeAwakeSettings } from "./awake.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-awake-"));
  dirs.push(dir);
  return dir;
}

describe("holdAwake", () => {
  const on = { whileWorking: true, onBattery: false };

  it("holds only while the setting is on, the server runs and an agent works", () => {
    expect(holdAwake({ settings: on, working: 1, onBattery: false, serverRunning: true })).toBe(true);
    expect(holdAwake({ settings: { ...on, whileWorking: false }, working: 1, onBattery: false, serverRunning: true })).toBe(false);
    expect(holdAwake({ settings: on, working: 0, onBattery: false, serverRunning: true })).toBe(false);
    expect(holdAwake({ settings: on, working: 1, onBattery: false, serverRunning: false })).toBe(false);
  });

  it("lets go on battery unless the user allowed it there", () => {
    expect(holdAwake({ settings: on, working: 1, onBattery: true, serverRunning: true })).toBe(false);
    expect(holdAwake({ settings: { ...on, onBattery: true }, working: 1, onBattery: true, serverRunning: true })).toBe(true);
  });
});

describe("awake settings", () => {
  it("hold the computer awake on power until the user chooses, and survive a restart", () => {
    const path = join(folder(), "awake.json");
    expect(readAwakeSettings(path)).toEqual({ whileWorking: true, onBattery: false });
    writeAwakeSettings(path, { whileWorking: true, onBattery: true });
    expect(readAwakeSettings(path)).toEqual({ whileWorking: true, onBattery: true });
    writeFileSync(path, "{ not json");
    expect(readAwakeSettings(path)).toEqual({ whileWorking: true, onBattery: false });
    writeFileSync(path, JSON.stringify({ whileWorking: "yes", onBattery: 1 }));
    expect(readAwakeSettings(path)).toEqual({ whileWorking: true, onBattery: false });
  });

  it("keep a choice the user saved, field by field", () => {
    const path = join(folder(), "awake.json");
    writeAwakeSettings(path, { whileWorking: false, onBattery: false });
    expect(readAwakeSettings(path)).toEqual({ whileWorking: false, onBattery: false });
    writeFileSync(path, JSON.stringify({ whileWorking: false }));
    expect(readAwakeSettings(path)).toEqual({ whileWorking: false, onBattery: false });
    writeFileSync(path, JSON.stringify({ onBattery: true }));
    expect(readAwakeSettings(path)).toEqual({ whileWorking: true, onBattery: true });
  });
});

describe("readWorking", () => {
  it("reads the server's count, and none from a missing or broken file", () => {
    const path = join(folder(), "desktop-activity.json");
    expect(readWorking(path)).toBe(0);
    writeFileSync(path, JSON.stringify({ working: 3 }));
    expect(readWorking(path)).toBe(3);
    for (const broken of ["{", JSON.stringify({ working: -1 }), JSON.stringify({ working: 1.5 }), JSON.stringify({ working: "2" })]) {
      writeFileSync(path, broken);
      expect(readWorking(path)).toBe(0);
    }
  });
});

describe("awakeLabel", () => {
  it("names how many agents keep the computer awake", () => {
    expect(awakeLabel(1)).toBe("Keeping this computer awake: 1 agent working");
    expect(awakeLabel(3)).toBe("Keeping this computer awake: 3 agents working");
  });
});
