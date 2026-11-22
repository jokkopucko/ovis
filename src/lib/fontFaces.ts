import { useSyncExternalStore } from "react";

export interface WatchedFace {
  readonly status: string;
  readonly loaded: Promise<unknown>;
}

/**
 * The faces whose arrival is still to come and is not followed yet; each is marked followed.
 * A face not asked for yet ("unloaded": a unicode-range chunk no text has needed) counts: its
 * `loaded` promise waits without starting the download, and the FontFaceSet tells nobody when
 * such a face starts loading while another is still in flight.
 */
export function facesToFollow<Face extends WatchedFace>(faces: Iterable<Face>, followed: WeakSet<Face>): Face[] {
  const next: Face[] = [];
  for (const face of faces) {
    if (face.status === "loaded" || face.status === "error" || followed.has(face)) continue;
    followed.add(face);
    next.push(face);
  }
  return next;
}

/**
 * A face is seen
 * here twice, when its own `loaded` promise resolves and again in the set's "loadingdone", and
 * is one arrival.
 */
export function facesArrived<Face extends WatchedFace>(faces: Iterable<Face>, counted: WeakSet<Face>): number {
  let fresh = 0;
  for (const face of faces) {
    if (face.status !== "loaded" || counted.has(face)) continue;
    counted.add(face);
    fresh += 1;
  }
  return fresh;
}

export interface WatchedFaceSet<Face extends WatchedFace> extends Iterable<Face> {
  addEventListener(type: "loading" | "loadingdone", listener: () => void): void;
}

/**
 * Calls `arrived` once for each face of the set that loads, now or later, and for none that
 * fails. Each face is followed by itself: the set's "loadingdone" waits for every pending load,
 * and one chunk stalled on a bad link would hold back the ones already drawn.
 */
export function watchFaces<Face extends WatchedFace>(fonts: WatchedFaceSet<Face>, arrived: () => void): void {
  const followed = new WeakSet<Face>();
  const counted = new WeakSet<Face>();
  const count = (faces: Iterable<Face>): void => { if (facesArrived(faces, counted) > 0) arrived(); };
  facesArrived(fonts, counted);
  const sweep = (): void => {
    for (const face of facesToFollow(fonts, followed)) face.loaded.then(() => count([face]), () => undefined);
  };
  sweep();
  // a face declared later (a stylesheet that came after this) is taken on when the set next stirs
  fonts.addEventListener("loading", sweep);
  // the backstop, for a face that loaded without having been followed: every pending load has
  // settled, and the ones counted by their own promise are not counted again
  fonts.addEventListener("loadingdone", () => { sweep(); count(fonts); });
}

let arrivals = 0;
let started = false;
const listeners = new Set<() => void>();

const arrived = (): void => {
  arrivals += 1;
  for (const listener of listeners) listener();
};

function start(): void {
  if (started) return;
  started = true;
  const fonts = typeof document === "undefined" ? undefined : document.fonts as FontFaceSet | undefined;
  if (!fonts || typeof fonts.addEventListener !== "function") return;
  watchFaces(fonts, arrived);
}

/** A face added already loaded (one made from bytes): the font set fires no event for it. */
export function faceArrived(): void {
  arrived();
}

const subscribe = (listener: () => void): (() => void) => {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * The app's faces swap in after
 * the first paint (fonts/fonts.css, `font-display: swap`) and are not as wide as the fallback
 * they replace: text rewraps and no box, font-size or family string changes for it, so nothing
 * else measures again.
 */
export function useFacesArrived(): number {
  return useSyncExternalStore(subscribe, () => arrivals, () => 0);
}
