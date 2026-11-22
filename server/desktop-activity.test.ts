import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busyPanes, DESKTOP_ACTIVITY_FILE, trackDesktopActivity, type DesktopActivity } from "./desktop-activity.ts";

const dirs: string[] = [];
const tracked: DesktopActivity[] = [];
afterEach(() => {
  for (const activity of tracked.splice(0)) activity.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function activityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-desktop-activity-"));
  dirs.push(dir);
  return join(dir, DESKTOP_ACTIVITY_FILE);
}

function track(path: string, working: () => Promise<number>): DesktopActivity {
  const activity = trackDesktopActivity({ path, working });
  tracked.push(activity);
  return activity;
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("trackDesktopActivity", () => {
  it("writes how many agents work, counts none when a read fails, and leaves no file once stopped", async () => {
    const path = activityFile();
    let answer: () => Promise<number> = async () => 2;
    const activity = track(path, () => answer());
    await activity.refresh();
    expect(read(path)).toEqual({ working: 2 });
    answer = async () => { throw new Error("hc is not answering"); };
    await activity.refresh();
    expect(read(path)).toEqual({ working: 0 });
    activity.stop();
    expect(existsSync(path)).toBe(false);
  });

  it("drops the count a server before it left behind", () => {
    const path = activityFile();
    writeFileSync(path, JSON.stringify({ working: 4 }));
    track(path, () => new Promise<number>(() => {}));
    expect(existsSync(path)).toBe(false);
  });

  it("ends on the newest count when an older read answers last", async () => {
    const path = activityFile();
    let now = 0;
    const answers: (() => void)[] = [];
    const activity = track(path, () => {
      const seen = now;
      return new Promise<number>((resolve) => answers.push(() => resolve(seen)));
    });
    const first = activity.refresh();
    now = 1;
    const second = activity.refresh();
    let settled = false;
    void Promise.all([first, second]).then(() => { settled = true; });
    const deadline = Date.now() + 5_000;
    while (!settled) {
      if (Date.now() > deadline) throw new Error("the reads did not settle");
      answers.pop()?.();
      await Bun.sleep(1);
    }
    expect(read(path)).toEqual({ working: 1 });
  });
});

describe("busyPanes", () => {
  it("counts an agent in a turn or at rest on its turn's background work", () => {
    expect(busyPanes([
      { agent_status: "working" },
      { agent_status: "idle", background_wait: true },
      { agent_status: "done", background_tasks: 2 },
      { agent_status: "idle", background_tasks: 0 },
      { agent_status: "blocked" },
      { agent_status: "done" },
    ])).toBe(3);
  });
});
