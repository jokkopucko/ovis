import { describe, expect, test } from "bun:test";
import { facesArrived, facesToFollow, watchFaces, type WatchedFace } from "./fontFaces.ts";

interface Fake extends WatchedFace { arrive: () => void; fail: () => void; status: string }

const face = (status: string): Fake => {
  let arrive = (): void => undefined;
  let fail = (): void => undefined;
  const loaded = new Promise<void>((resolve, reject) => { arrive = resolve; fail = () => reject(new Error("network")); });
  const fake: Fake = { status, loaded, arrive: () => { fake.status = "loaded"; arrive(); }, fail: () => { fake.status = "error"; fail(); } };
  return fake;
};
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

const faceSet = (faces: Fake[]) => {
  const listeners = new Map<string, () => void>();
  let arrivals = 0;
  watchFaces({ [Symbol.iterator]: () => faces[Symbol.iterator](), addEventListener: (type, listener) => { listeners.set(type, listener); } }, () => { arrivals += 1; });
  return { arrivals: () => arrivals, fire: (type: "loading" | "loadingdone") => listeners.get(type)!() };
};

describe("faces whose arrival is followed", () => {
  test("a face in flight and one no text has asked for yet are followed; a drawn or failed one is not", () => {
    const loading = face("loading");
    const unloaded = face("unloaded");
    expect(facesToFollow([face("loaded"), loading, unloaded, face("error")], new WeakSet())).toEqual([loading, unloaded]);
  });

  test("a face is followed once, however often the set is swept", () => {
    const followed = new WeakSet<Fake>();
    const first = face("loading");
    expect(facesToFollow([first], followed)).toEqual([first]);
    const later = face("unloaded");
    expect(facesToFollow([first, later], followed)).toEqual([later]);
    expect(facesToFollow([first, later], followed)).toEqual([]);
  });

  test("each face reports its own arrival while another is still in flight", async () => {
    const stalled = face("loading");
    const quick = face("loading");
    const late = face("unloaded");
    const set = faceSet([stalled, quick, late]);
    quick.arrive();
    await settled();
    expect(set.arrivals()).toBe(1);
    late.arrive();
    await settled();
    expect(set.arrivals()).toBe(2);
  });

  test("a face that loaded is one arrival, with the set's loadingdone after it", async () => {
    const first = face("loading");
    const second = face("loading");
    const set = faceSet([face("loaded"), first, second]);
    first.arrive();
    second.arrive();
    await settled();
    expect(set.arrivals()).toBe(2);
    set.fire("loadingdone");
    await settled();
    expect(set.arrivals()).toBe(2);
  });

  test("a face that fails to load is not an arrival, nor is the batch it was in, and is not an unhandled rejection", async () => {
    const lost = face("loading");
    const set = faceSet([face("loaded"), lost]);
    lost.fail();
    await settled();
    set.fire("loadingdone");
    await settled();
    expect(set.arrivals()).toBe(0);
  });

  test("a face declared later is taken on when the set stirs, and one never followed is counted when all have settled", async () => {
    const faces = [face("loading")];
    const set = faceSet(faces);
    const later = face("loading");
    faces.push(later);
    set.fire("loading");
    later.arrive();
    await settled();
    expect(set.arrivals()).toBe(1);
    faces.push(face("loaded"), face("error"));
    set.fire("loadingdone");
    expect(set.arrivals()).toBe(2);
    set.fire("loadingdone");
    expect(set.arrivals()).toBe(2);
  });

  test("a loaded face is counted once, and a failed or pending one never", () => {
    const counted = new WeakSet<Fake>();
    const drawn = face("loaded");
    expect(facesArrived([drawn, face("error"), face("loading"), face("unloaded")], counted)).toBe(1);
    expect(facesArrived([drawn], counted)).toBe(0);
  });
});
