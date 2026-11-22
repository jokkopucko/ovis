/**
 * The owner's animated Ovis mascot (owner-made, 2026-11; ported from his ovis-vector-kit engine): the
 * navy sheep and one of eight small performances, drawn as inline SVG and moved each animation frame.
 * Loaded on its own (SheepMascot imports it lazily) so no other screen carries it. Nothing external is
 * fetched: every path is in mascotData.ts.
 */
import { EYES, PARTS, PROPS, TRACKS } from "./mascotData.ts";

export type MascotState = "hello" | "connecting" | "approval" | "done" | "asleep" | "refused" | "sign-in" | "captain";

const DURATION = 4.8, TAU = Math.PI * 2, NAVY = "#2E3A59", ORANGE = "#C47A14", PEACH = "#F7C4B0";

type Vec = [number, number];
type Turn = [number, number, number];
interface Pose {
  actorT: Vec; actorR: Turn; actorS: Vec; headT: Vec; headR: Turn;
  propT: Vec; propR: Turn; propS: Vec; propOpacity: number;
  zzz: { translate: Vec; scale: Vec; opacity: number }[];
  eyeLeft: string; eyeRight: string;
}

const clamp = (x: number): number => Math.max(0, Math.min(1, x));
const smoother = (x: number): number => { const c = clamp(x); return c * c * c * (10 + c * (-15 + 6 * c)); };
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function track(points: readonly number[], t: number): number {
  if (t <= points[0]!) return points[1]!;
  for (let i = 2; i < points.length; i += 2) {
    if (t <= points[i]!) return mix(points[i - 1]!, points[i + 1]!, smoother((t - points[i - 2]!) / (points[i]! - points[i - 2]!)));
  }
  return points[points.length - 1]!;
}

function keys(...pairs: Vec[]): number[] { return pairs.flat(); }

function bump(t: number, a: number, b: number): number {
  return t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a)) ** 4;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

function eyePath(index: number, progress: number, gx: number, gy: number): string {
  const poses = EYES[index]!, v = clamp(progress) * (poses.length - 1), i = Math.min(poses.length - 2, Math.floor(v)), f = v - i;
  const a = poses[Math.max(0, i - 1)]!, b = poses[i]!, c = poses[i + 1]!, d = poses[Math.min(poses.length - 1, i + 2)]!;
  let out = "";
  for (let p = 0; p < b.length; p += 2) {
    out += `${p ? "L" : "M"}${(cubic(a[p]!, b[p]!, c[p]!, d[p]!, f) + gx).toFixed(3)} ${(cubic(a[p + 1]!, b[p + 1]!, c[p + 1]!, d[p + 1]!, f) + gy).toFixed(3)}`;
  }
  return `${out}Z`;
}

function choreography(state: MascotState, seconds: number): Pose {
  const t = ((seconds % DURATION) + DURATION) % DURATION, phase = t / DURATION, breath = Math.sin(TAU * phase), tracks = TRACKS[state]!;
  const p: Pose = {
    actorT: [0, -0.45 * breath], actorR: [0, 160, 180], actorS: [1 + 0.0025 * breath, 1 + 0.004 * breath], headT: [0, 0], headR: [0, 160, 174],
    propT: [0, 0], propR: [0, 278, 244], propS: [1, 1], propOpacity: 1, zzz: [], eyeLeft: "", eyeRight: "",
  };
  if (state === "hello") {
    const greeting = bump(t, 0.45, 2.05), returning = bump(t, 2.35, 4.25);
    p.actorR[0] = -3.8 * greeting + 2.4 * returning; p.headR[0] = -0.7 * greeting; p.headT[1] = -0.8 * greeting;
  } else if (state === "connecting") {
    const turn = track(keys([0, 0], [0.9, -1], [1.55, 0], [2.55, 1], [3.4, 0], [4.15, -0.45], [4.8, 0]), t);
    p.actorR[0] = 2.1 * turn; p.headT[0] = 1.7 * turn; p.headR[0] = 1.2 * turn;
    p.propR[0] = 4 * Math.sin(TAU * phase * 2); p.propT[1] = -1.4 * bump(t, 0.7, 1.5) - 1.4 * bump(t, 2.8, 3.6);
  } else if (state === "approval") {
    const wait = track(keys([0, 0], [0.85, 0.2], [1.7, 1], [2.8, 1], [3.8, 0.3], [4.8, 0]), t);
    p.actorR[0] = -3.2 * wait; p.headR[0] = -0.8 * wait; p.headT[1] = -0.6 * wait;
    p.propR = [1.8 * bump(t, 0.55, 1.45) - 1.3 * bump(t, 1.35, 2.25), 160, 261]; p.propT[1] = -0.8 * bump(t, 0.45, 1.5);
  } else if (state === "done") {
    const nod = bump(t, 0.65, 2.05), rebound = bump(t, 2.1, 3.25);
    p.actorR[0] = 2.6 * nod - 1.1 * rebound; p.headT[1] = 2.2 * nod - 0.7 * rebound; p.headR[0] = 0.8 * nod;
    const reveal = track(keys([0, 0], [0.35, 0], [1.1, 1.06], [1.5, 1], [3.9, 1], [4.8, 0]), t);
    p.propS = [reveal, reveal]; p.propOpacity = clamp(reveal / 0.08); p.propT[1] = -1.6 * bump(t, 0.5, 1.35);
  } else if (state === "asleep") {
    p.actorT = [0, -1.2 * breath]; p.actorS = [1 - 0.005 * breath, 1 + 0.015 * breath]; p.actorR[0] = -1.4 + 0.7 * Math.sin(TAU * phase);
    p.headR[0] = -3.4 - 0.65 * breath; p.headT[1] = 1.3 + 0.55 * breath; p.propOpacity = 0;
    for (let i = 0; i < 2; i++) {
      const u = (phase + i * 0.5) % 1, scale = 0.95 * Math.sin(Math.PI * u) ** 4;
      p.zzz.push({ translate: [259 + 12 * u, 109 - 54 * u], scale: [scale, scale], opacity: clamp(scale / 0.055) });
    }
  } else if (state === "refused") {
    const shake = Math.sin(TAU * (t - 0.55) / 1.32) * bump(t, 0.55, 3.85);
    p.actorR[0] = 3.5 * shake; p.headT[0] = 1.05 * shake; p.headR[0] = -0.7 * shake;
    p.propR[0] = -3.2 * shake; p.propT[0] = -0.65 * shake;
  } else if (state === "sign-in") {
    const wake = track(keys([0, 0], [0.4, 0], [1.55, 1], [3.3, 1], [4.8, 0]), t), notice = bump(t, 1.5, 3.85);
    p.actorT[1] -= 1.1 * wake; p.actorR[0] = 2.6 * notice; p.headT[0] = 0.8 * notice; p.headT[1] = -0.9 * wake; p.headR[0] = 0.8 * notice;
    p.propR[0] = -19 * bump(t, 1.8, 3.5); p.propT[0] = -1.4 * bump(t, 1.8, 3.5);
  } else {
    const nod = bump(t, 0.8, 2.4), settle = bump(t, 2.5, 3.65);
    p.actorR[0] = -1.6 * nod + 0.6 * settle; p.headT[1] = 1.8 * nod - 0.4 * settle; p.headR[0] = 0.5 * nod;
    p.propR = [-7 * bump(t, 1.0, 2.4), 160, 50]; p.propT[1] = -1.8 * bump(t, 1.0, 2.4);
  }
  if (state !== "asleep") for (let i = 0; i < 2; i++) p.zzz.push({ translate: [259, 109], scale: [0, 0], opacity: 0 });
  // the default sheep is the logo's own: it tilts and breathes, and its eyes stay closed (the owner's word, 2026-11)
  const calm = state === "hello";
  const gazeX = calm ? 0 : track(tracks.gazeX, t), gazeY = calm ? 0 : track(tracks.gazeY, t);
  p.eyeLeft = eyePath(0, calm ? 0 : track(tracks.left, t), gazeX, gazeY);
  p.eyeRight = eyePath(1, calm ? 0 : track(tracks.right, t), gazeX, gazeY);
  return p;
}

type RigKind = "translate" | "rotate" | "scale" | "opacity";
const RIG: Readonly<Record<string, { kind: RigKind; get: (p: Pose) => readonly number[] }>> = {
  "actor-position": { kind: "translate", get: (p) => p.actorT }, "actor-angle": { kind: "rotate", get: (p) => p.actorR }, "actor-size": { kind: "scale", get: (p) => p.actorS },
  "head-position": { kind: "translate", get: (p) => p.headT }, "head-angle": { kind: "rotate", get: (p) => p.headR },
  "prop-position": { kind: "translate", get: (p) => p.propT }, "prop-angle": { kind: "rotate", get: (p) => p.propR }, "prop-size": { kind: "scale", get: (p) => p.propS }, "prop-opacity": { kind: "opacity", get: (p) => [p.propOpacity] },
  "zzz-0-position": { kind: "translate", get: (p) => p.zzz[0]!.translate }, "zzz-0-size": { kind: "scale", get: (p) => p.zzz[0]!.scale }, "zzz-0-opacity": { kind: "opacity", get: (p) => [p.zzz[0]!.opacity] },
  "zzz-1-position": { kind: "translate", get: (p) => p.zzz[1]!.translate }, "zzz-1-size": { kind: "scale", get: (p) => p.zzz[1]!.scale }, "zzz-1-opacity": { kind: "opacity", get: (p) => [p.zzz[1]!.opacity] },
};
const RIG_NAMES = Object.keys(RIG);

const nums = (values: readonly number[]): string => values.map((v) => Number(v.toFixed(6))).join(" ");
const rigValue = (name: string, p: Pose): string => { const rig = RIG[name]!; return rig.kind === "opacity" ? nums(rig.get(p)) : `${rig.kind}(${nums(rig.get(p))})`; };
const rigAttr = (name: string): "opacity" | "transform" => RIG[name]!.kind === "opacity" ? "opacity" : "transform";
const group = (name: string, p: Pose, content: string): string => `<g data-rig="${name}" ${rigAttr(name)}="${rigValue(name, p)}">${content}</g>`;
const part = (markup: string, fill: string): string => `<g fill="${fill}" transform="scale(.5)">${markup}</g>`;

/**
 * The props read at a glance (the owner's word, 2026-11): each is half again the kit's size, about its own
 * centre, so it overlaps the wool's edge, and below 96 px it grows by `small` more with an outline of its
 * own colour. The sheep itself never changes.
 */
const PROP_GROW: Partial<Record<MascotState, { at: Vec; small: number }>> = {
  connecting: { at: [280, 245], small: 1.8 },
  approval: { at: [160, 261], small: 1.5 },
  done: { at: [288, 244], small: 1.8 },
  refused: { at: [284, 247], small: 1.8 },
  "sign-in": { at: [286, 245], small: 1.8 },
  captain: { at: [160, 40], small: 1 },
};
const PROP_SCALE = 1.5;
export const SMALL_BELOW_PX = 96;

function propMarkup(state: MascotState, small: boolean): string {
  const markup = PROPS[state] ?? "";
  const grow = PROP_GROW[state];
  if (!grow) return markup;
  const [x, y] = grow.at;
  const scale = small ? PROP_SCALE * grow.small : PROP_SCALE;
  const drawn = small ? markup.replaceAll(`fill="${ORANGE}"`, `fill="${ORANGE}" stroke="${ORANGE}" stroke-width="2" stroke-linejoin="round"`) : markup;
  return `<g transform="translate(${x} ${y}) scale(${scale}) translate(${-x} ${-y})">${drawn}</g>`;
}

/** grown as the props are, and drawn further left as they grow so the trail stays inside the view box */
function sleepLetters(small: boolean): string {
  const z = '<path d="M0 0H10V2.5L3.3 11.5H10V14H0V11.5L6.7 2.5H0Z"/>';
  const at = small ? "translate(-62 -12) scale(2.7)" : `translate(-16 -4) scale(${PROP_SCALE})`;
  return `<g fill="${ORANGE}" transform="${at}">${z}<g transform="translate(11 3) scale(.75)">${z}</g><g transform="translate(20 6) scale(.57)">${z}</g><circle cx="28" cy="14" r=".8"/><circle cx="31" cy="14" r=".8"/><circle cx="34" cy="14" r=".8"/></g>`;
}

export function mascotSvg(state: MascotState, seconds: number, small: boolean): string {
  const p = choreography(state, seconds);
  const eyes = `<g fill="${NAVY}"><path data-eye="left" d="${p.eyeLeft}"/><path data-eye="right" d="${p.eyeRight}"/></g>`;
  const head = group("head-position", p, group("head-angle", p, part(PARTS.face, PEACH) + part(PARTS.muzzle, NAVY) + eyes));
  const pivot: Vec = state === "approval" ? [160, 261] : state === "captain" ? [160, 50] : [278, 244];
  const prop = group("prop-size", p, `<g transform="translate(${-pivot[0]} ${-pivot[1]})">${group("prop-opacity", p, propMarkup(state, small))}</g>`);
  const accessory = group("prop-position", p, group("prop-angle", p, `<g transform="translate(${pivot[0]} ${pivot[1]})">${prop}</g>`));
  const body = group("actor-size", p, `<g transform="translate(-160 -180)">${part(PARTS.wool, NAVY)}${head}${accessory}</g>`);
  const actor = group("actor-position", p, group("actor-angle", p, `<g transform="translate(160 180)">${body}</g>`));
  const letters = [0, 1].map((i) => group(`zzz-${i}-position`, p, group(`zzz-${i}-size`, p, group(`zzz-${i}-opacity`, p, sleepLetters(small))))).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" aria-hidden="true" focusable="false" data-mascot="${state}">${actor}${letters}</svg>`;
}

/**
 * Draws the mascot into `host` and plays one pass of its loop (4.8 s, under the 5 s past which moving content
 * needs a pause control), then settles on the loop's first pose. `quiet`, the reduced-motion query, is read on
 * every frame: matching, the first pose is drawn and the play ends, whenever it starts to match.
 */
export function playMascot(host: HTMLElement, state: MascotState, { small, quiet }: { readonly small: boolean; readonly quiet: MediaQueryList | null }): () => void {
  const template = document.createElement("template");
  template.innerHTML = mascotSvg(state, 0, small);
  const svg = template.content.firstElementChild as SVGSVGElement;
  host.replaceChildren(svg);
  if (quiet?.matches === true) return () => { svg.remove(); };
  const eyes = [svg.querySelector('[data-eye="left"]')!, svg.querySelector('[data-eye="right"]')!];
  const rigs = RIG_NAMES.map((name) => [name, svg.querySelector(`[data-rig="${name}"]`)!] as const);
  let frame = 0, start: number | null = null;
  const tick = (now: number): void => {
    if (!svg.isConnected) return;
    start ??= now;
    const done = (now - start) / 1000 >= DURATION || quiet?.matches === true;
    const p = choreography(state, done ? 0 : (now - start) / 1000);
    eyes[0]!.setAttribute("d", p.eyeLeft);
    eyes[1]!.setAttribute("d", p.eyeRight);
    for (const [name, el] of rigs) el.setAttribute(rigAttr(name), rigValue(name, p));
    if (!done) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(frame); svg.remove(); };
}
