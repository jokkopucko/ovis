import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { CHIME_NOTES, playAlertSound, previewAlertSound, recheckAlertSounds, unlockAlertSound } from "./alertSound.ts";

/** A stand-in AudioContext that starts suspended, as a page's does before any tap or key. */
const started: number[] = [];
const startedAt: number[] = [];
const cut: number[] = [];
let disconnected = 0;
let resumes = 0;
const made: FakeAudioContext[] = [];
class FakeAudioContext {
  // "interrupted" is iOS Safari's state after a phone call or a switch away: not in the DOM typings
  state: "suspended" | "running" | "closed" | "interrupted" = "suspended";
  constructor() { made.push(this); }
  currentTime = 0;
  destination = {};
  async resume() { resumes += 1; this.state = "running"; }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node, disconnect() { disconnected += 1; } };
  }
  createOscillator() {
    const oscillator = {
      type: "",
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      startAt: 0,
      start(at: number) { started.push(oscillator.frequency.value); startedAt.push(at); oscillator.startAt = at; },
      stop(at: number) { if (at < oscillator.startAt) cut.push(oscillator.frequency.value); },
    };
    return oscillator;
  }
}

/** How long a chime sounds: its last note starts 0.16 s after the one before and lasts 0.3 s. */
const LENGTH = 0.16 + 0.3;

const saved = (globalThis as { AudioContext?: unknown }).AudioContext;
Object.assign(globalThis, { AudioContext: FakeAudioContext });
afterAll(() => {
  for (const audio of made) audio.state = "closed";
  Object.assign(globalThis, { AudioContext: saved });
});

function quiet(): FakeAudioContext {
  const audio = made.at(-1)!;
  audio.currentTime += 10;
  started.length = 0;
  startedAt.length = 0;
  cut.length = 0;
  disconnected = 0;
  return audio;
}

describe("alert sound", () => {
  it("skips a chime before the page was allowed to play audio, instead of queueing it", () => {
    playAlertSound("blocked");
    expect(started).toEqual([]);
  });

  it("plays each kind's notes once a gesture unlocked the tab", async () => {
    expect(await unlockAlertSound()).toBe(true);
    expect(resumes).toBe(1);
    playAlertSound("blocked");
    quiet();
    playAlertSound("done");
    expect(started).toEqual([...CHIME_NOTES.done]);
  });

  it("tells a question, which rises, from a finish, which falls", () => {
    expect(CHIME_NOTES.blocked[0]!).toBeLessThan(CHIME_NOTES.blocked[1]!);
    expect(CHIME_NOTES.done[0]!).toBeGreaterThan(CHIME_NOTES.done[1]!);
  });

  it("reuses the running context on later gestures", async () => {
    expect(await unlockAlertSound()).toBe(true);
    expect(resumes).toBe(1);
    expect(made.length).toBe(1);
  });

  it("makes a new context on the next gesture once the browser closed the old one", async () => {
    quiet().state = "closed";
    playAlertSound("done");
    expect(started).toEqual([]);
    expect(await unlockAlertSound()).toBe(true);
    expect(made.length).toBe(2);
    playAlertSound("done");
    expect(started).toEqual([...CHIME_NOTES.done]);
  });

  it("resumes a context iOS Safari interrupted, on the next gesture", async () => {
    quiet().state = "interrupted";
    playAlertSound("blocked");
    expect(started).toEqual([]);
    const before = resumes;
    expect(await unlockAlertSound()).toBe(true);
    expect(resumes).toBe(before + 1);
    expect(made.length).toBe(2);
    playAlertSound("blocked");
    expect(started).toEqual([...CHIME_NOTES.blocked]);
  });
});

describe("one chime at a time", () => {
  beforeAll(async () => { await unlockAlertSound(); });
  beforeEach(() => { quiet(); });

  it("chimes once for panes that finish together", () => {
    playAlertSound("done");
    playAlertSound("done");
    playAlertSound("done");
    expect(started).toEqual([...CHIME_NOTES.done]);
  });

  it("starts a question's chime where the finish's ends, and tells the rest by those two", () => {
    const now = made.at(-1)!.currentTime;
    playAlertSound("done");
    playAlertSound("blocked");
    playAlertSound("done");
    playAlertSound("blocked");
    expect(started).toEqual([...CHIME_NOTES.done, ...CHIME_NOTES.blocked]);
    expect(startedAt[2]).toBeCloseTo(now + LENGTH);
  });

  it("tells a finish that comes during a question by the question's chime", () => {
    playAlertSound("blocked");
    playAlertSound("done");
    expect(started).toEqual([...CHIME_NOTES.blocked]);
  });

  it("chimes again once the last chime ended", () => {
    const audio = made.at(-1)!;
    playAlertSound("done");
    audio.currentTime += LENGTH;
    playAlertSound("done");
    expect(started).toEqual([...CHIME_NOTES.done, ...CHIME_NOTES.done]);
  });

  it("confirms a queued question only after its audio clock reaches its start", async () => {
    const audio = made.at(-1)!;
    playAlertSound("done");
    const pending = playAlertSound("blocked");
    expect(pending).toBeInstanceOf(Promise);
    let confirmed = false;
    void Promise.resolve(pending).then(() => { confirmed = true; });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    audio.currentTime += LENGTH;
    expect(await pending).toBe(true);
  });

  it("does not confirm a queued question if audio was interrupted before starting", async () => {
    const audio = made.at(-1)!;
    playAlertSound("done");
    const pending = playAlertSound("blocked");
    audio.state = "interrupted";
    expect(await pending).toBe(false);
    await unlockAlertSound();
  });

  it("silences a queued question no longer wanted when asked again, and gives its place back", async () => {
    const audio = made.at(-1)!;
    const now = audio.currentTime;
    let muted = false;
    playAlertSound("done");
    const pending = playAlertSound("blocked", () => !muted);
    expect(started).toEqual([...CHIME_NOTES.done, ...CHIME_NOTES.blocked]);
    recheckAlertSounds();
    expect(cut).toEqual([]);
    audio.currentTime += 0.1;
    muted = true;
    recheckAlertSounds();
    expect(cut).toEqual([...CHIME_NOTES.blocked]);
    expect(disconnected).toBe(CHIME_NOTES.blocked.length);
    expect(await pending).toBe(false);
    playAlertSound("blocked");
    expect(startedAt.at(-2)).toBeCloseTo(now + LENGTH);
  });

  it("keeps a question chime two panes share for the one still unmuted, and confirms it only to that one", async () => {
    const audio = made.at(-1)!;
    const muted = new Set<string>();
    playAlertSound("done");
    const b = playAlertSound("blocked", () => !muted.has("B"));
    const c = playAlertSound("blocked", () => !muted.has("C"));
    expect(started).toEqual([...CHIME_NOTES.done, ...CHIME_NOTES.blocked]);
    audio.currentTime += 0.1;
    muted.add("B");
    recheckAlertSounds();
    expect(cut).toEqual([]);
    expect(disconnected).toBe(0);
    audio.currentTime += LENGTH;
    expect([await b, await c]).toEqual([false, true]);
  });

  it("silences a question chime two panes share once both are muted, and confirms it to neither", async () => {
    const audio = made.at(-1)!;
    let muted = false;
    playAlertSound("done");
    const b = playAlertSound("blocked", () => !muted);
    const c = playAlertSound("blocked", () => !muted);
    audio.currentTime += 0.1;
    muted = true;
    recheckAlertSounds();
    expect(cut).toEqual([...CHIME_NOTES.blocked]);
    expect([await b, await c]).toEqual([false, false]);
  });

  it("a question cancelled with a preview waiting behind it does not swallow a later pane's question", async () => {
    const audio = made.at(-1)!;
    let muted = false;
    playAlertSound("done");
    const b = playAlertSound("blocked", () => !muted);
    previewAlertSound();
    audio.currentTime += 0.1;
    muted = true;
    recheckAlertSounds();
    expect(await b).toBe(false);
    audio.currentTime += 0.1;
    const c = playAlertSound("blocked");
    expect(started).toEqual([...CHIME_NOTES.done, ...CHIME_NOTES.blocked, ...CHIME_NOTES.done, ...CHIME_NOTES.blocked]);
    audio.currentTime += 3 * LENGTH;
    expect(await c).toBe(true);
  });

  it("previews the chime in Settings, after the chime that sounds", () => {
    const now = made.at(-1)!.currentTime;
    previewAlertSound();
    playAlertSound("blocked");
    expect(started).toEqual([...CHIME_NOTES.done, ...CHIME_NOTES.blocked]);
    quiet();
    playAlertSound("blocked");
    previewAlertSound();
    expect(started).toEqual([...CHIME_NOTES.blocked, ...CHIME_NOTES.done]);
    expect(startedAt[2]).toBeCloseTo(now + 10 + LENGTH);
  });

  it("tells a question by the question that sounds, also with a preview waiting behind it", () => {
    const audio = made.at(-1)!;
    playAlertSound("blocked");
    previewAlertSound();
    playAlertSound("blocked");
    expect(started).toEqual([...CHIME_NOTES.blocked, ...CHIME_NOTES.done]);
    audio.currentTime += LENGTH + 0.01;
    playAlertSound("blocked");
    expect(started).toEqual([...CHIME_NOTES.blocked, ...CHIME_NOTES.done, ...CHIME_NOTES.blocked]);
  });
});
