/**
 * The alert sound: a short chime the open tab plays itself when an alert is due. It is page
 * audio, not a system notification, so it is heard where notifications stay quiet - a macOS
 * Focus, Do Not Disturb - as long as a tab of the app is open.
 *
 * A browser lets a page play audio only after the user interacted with it, so the audio context
 * is made and resumed from a tap or key (`unlockAlertSound`); until then a chime is skipped,
 * never queued to sound late.
 */

export type AlertSoundKind = "blocked" | "done";

export const CHIME_NOTES: Readonly<Record<AlertSoundKind, readonly number[]>> = {
  blocked: [660, 880],
  done: [880, 660],
};
const NOTE_GAP_S = 0.16;
const NOTE_LENGTH_S = 0.3;
const PEAK_GAIN = 0.25;

let context: AudioContext | null = null;
interface Scheduled {
  audio: AudioContext;
  start: number;
  wanters: (() => boolean)[];
  cancelled: boolean;
  cancel: () => void;
}
let sounding: { audio: AudioContext; until: number; question: number; questionStart: number; questionSound: Scheduled | null } | null = null;
const queued = new Set<Scheduled>();

function contextClass(): typeof AudioContext | undefined {
  return globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export async function unlockAlertSound(): Promise<boolean> {
  const Context = contextClass();
  if (!Context) return false;
  // a context the browser closed never resumes: the next gesture makes a new one
  if (!context || context.state === "closed") context = new Context();
  // suspended before the first gesture, or "interrupted" (iOS Safari, after a call or a switch away):
  // both resume from a gesture
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }
  return context.state === "running";
}

export function canPlayAlertSound(): boolean {
  return context?.state === "running";
}

export function playAlertSound(kind: AlertSoundKind, wanted: () => boolean = () => true): boolean | Promise<boolean> {
  const audio = context;
  if (audio?.state !== "running") return false;
  const { start, sound } = chime(audio, kind);
  if (start <= audio.currentTime || sound === null) return true;
  sound.wanters.push(wanted);
  queued.add(sound);
  return new Promise((resolve) => {
    const check = () => {
      if (sound.cancelled || audio.state !== "running" || context !== audio) { resolve(false); return; }
      const remaining = start - audio.currentTime;
      if (remaining > 0) { setTimeout(check, Math.ceil(remaining * 1_000)); return; }
      queued.delete(sound);
      resolve(wanted());
    };
    check();
  });
}

export function recheckAlertSounds(): void {
  for (const sound of [...queued]) {
    if (sound.start <= sound.audio.currentTime) { queued.delete(sound); continue; }
    if (!sound.wanters.some((wanted) => wanted())) { queued.delete(sound); sound.cancel(); }
  }
}

export function previewAlertSound(): void {
  const audio = context;
  if (audio?.state === "running") chime(audio, "done", true);
}

function chime(audio: AudioContext, kind: AlertSoundKind, preview = false): { start: number; sound: Scheduled | null } {
  const now = audio.currentTime;
  const current = sounding !== null && sounding.audio === audio && sounding.until > now ? sounding : null;
  const question = current !== null && current.question > now && current.questionSound?.cancelled !== true;
  if (current && !preview && (kind === "done" || question)) {
    if (kind === "done" || current.questionStart <= now) return { start: now, sound: null };
    return { start: current.questionStart, sound: current.questionSound };
  }
  const start = current ? current.until : now;
  const notes = CHIME_NOTES[kind];
  const gains: GainNode[] = [];
  const oscillators: OscillatorNode[] = [];
  notes.forEach((frequency, index) => {
    const at = start + index * NOTE_GAP_S;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    // a ramp from near silence on both ends: a note that starts or stops at full level clicks
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH_S);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + NOTE_LENGTH_S);
    gains.push(gain);
    oscillators.push(oscillator);
  });
  const until = start + (notes.length - 1) * NOTE_GAP_S + NOTE_LENGTH_S;
  const sound: Scheduled | null = start > now ? {
    audio, start, wanters: [], cancelled: false,
    cancel: () => {
      sound!.cancelled = true;
      // a stop before its start keeps a note from ever sounding; cut off from the output as well
      for (const oscillator of oscillators) oscillator.stop(audio.currentTime);
      for (const gain of gains) gain.disconnect();
      if (sounding === mine) sounding = current;
    },
  } : null;
  const asks = kind === "blocked" && !preview;
  const mine = {
    audio, until,
    question: asks ? until : current?.question ?? 0,
    questionStart: asks ? start : current?.questionStart ?? 0,
    questionSound: asks ? sound : current?.questionSound ?? null,
  };
  sounding = mine;
  return { start, sound };
}
