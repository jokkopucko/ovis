import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime } from "bun:test";
import { stateWatch, type UnseenLook } from "./agentStateWatch.ts";

const T = 1_800_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;

describe("the watch the state stamps go by", () => {
  let end: () => void;
  let unseen: UnseenLook[];

  const runs = (ms: number): void => { jest.advanceTimersByTime(ms); };
  const sleeps = (ms: number): void => { jest.setSystemTime(new Date(Date.now() + ms)); };
  const reads = (): void => { stateWatch.read(stateWatch.asked()); };
  const streams = (): void => { stateWatch.subscription("opened"); stateWatch.pushed(); };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T));
    unseen = [];
    end = stateWatch.keep((look) => { unseen.push(look); });
  });

  afterEach(() => {
    end();
    jest.useRealTimers();
    setSystemTime();
  });

  it("has lost nothing while no roster was told to it", () => {
    sleeps(60 * MIN);
    expect(stateWatch.blind()).toBe(false);
    reads();
    expect(unseen).toEqual([]);
  });

  it("holds through a quiet hour of an open stream while the page runs", () => {
    streams();
    runs(60 * MIN);
    expect(stateWatch.blind()).toBe(false);

    stateWatch.pushed();
    expect(unseen).toEqual([]);
  });

  it("holds in a hidden tab, whose timers run about once a minute", () => {
    streams();
    for (let minute = 0; minute < 30; minute++) {
      sleeps(MIN - 5 * SEC);
      runs(5 * SEC);
    }
    expect(stateWatch.blind()).toBe(false);
  });

  it("reads the roster after a sleep as a first look, and trusts nothing held back or asked before it", () => {
    streams();
    const askedBefore = stateWatch.asked();
    sleeps(60 * MIN);
    expect(stateWatch.blind()).toBe(true);

    stateWatch.heard();
    stateWatch.pushed();
    stateWatch.read(askedBefore);
    expect(unseen).toEqual([]);
    expect(stateWatch.blind()).toBe(true);

    reads();
    expect(unseen).toEqual(["first"]);
    expect(stateWatch.blind()).toBe(false);
    runs(10 * MIN);
    expect(stateWatch.blind()).toBe(false);
  });

  it("dates what a stream brings when it reconnects soon, and reads a long loss as a first look", () => {
    streams();
    runs(2 * MIN);
    stateWatch.heard();
    stateWatch.subscription("lost");
    runs(30 * SEC);
    streams();
    expect(unseen).toEqual([]);

    stateWatch.subscription("lost");
    runs(5 * MIN);
    expect(stateWatch.blind()).toBe(true);
    streams();
    expect(unseen).toEqual(["first"]);
    expect(stateWatch.blind()).toBe(false);
  });

  it("holds on reads alone while no stream is open", () => {
    reads();
    for (let read = 0; read < 120; read++) {
      runs(5 * SEC);
      expect(stateWatch.blind()).toBe(false);
      reads();
    }
    expect(unseen).toEqual([]);
  });

  it("reads the roster after the server was out of reach for long as a first look", () => {
    streams();
    stateWatch.subscription("lost");
    runs(5 * MIN);
    reads();
    expect(unseen).toEqual(["first"]);
  });

  it("dates no change a read finds after the stream said nothing for long: silent, or dead", () => {
    streams();
    runs(10 * MIN);
    reads();
    expect(unseen).toEqual(["undated"]);

    runs(10 * MIN);
    stateWatch.heard();
    reads();
    expect(unseen).toEqual(["undated"]);
  });

  it("takes back the word of a silent stream that ends just after a read trusted it: it was dead, for no telling how long", () => {
    streams();
    runs(10 * MIN);
    reads();
    expect(unseen).toEqual(["undated"]);
    runs(6 * SEC);
    stateWatch.subscription("lost");
    expect(unseen).toEqual(["undated", "first"]);
    stateWatch.subscription("closed");
    expect(unseen).toEqual(["undated", "first"]);
  });

  it("knows its PCs only as of the last roster or event once a silent stream has ended: the stream may have been dead since", () => {
    streams();
    runs(10 * MIN);
    stateWatch.subscription("lost");
    expect(stateWatch.blind()).toBe(true);
    reads();
    expect(unseen).toEqual(["first"]);

    streams();
    runs(10 * MIN);
    stateWatch.subscription("lost");
    runs(5 * SEC);
    streams();
    expect(unseen).toEqual(["first", "first"]);
  });

  it("takes the end of a stream for a short gap in a visible tab, whose reads say every half minute what the stream left unsaid", () => {
    streams();
    for (let read = 0; read < 20; read++) {
      runs(30 * SEC);
      reads();
    }
    stateWatch.subscription("lost");
    expect(stateWatch.blind()).toBe(false);
    runs(20 * SEC);
    streams();
    expect(unseen).toEqual([]);
  });

  it("dates nothing at the first roster of a stream that took over from one that had said nothing for long", () => {
    streams();
    runs(10 * MIN);
    stateWatch.subscription("opened");
    stateWatch.pushed();
    expect(unseen).toEqual(["undated"]);
    runs(10 * MIN);
    stateWatch.pushed();
    expect(unseen).toEqual(["undated"]);

    runs(10 * MIN);
    stateWatch.subscription("opened");
    stateWatch.pushed();
    runs(5 * SEC);
    stateWatch.subscription("lost");
    expect(unseen).toEqual(["undated", "undated"]);

    streams();
    runs(10 * MIN);
    stateWatch.heard();
    stateWatch.subscription("opened");
    stateWatch.pushed();
    expect(unseen).toEqual(["undated", "undated"]);
  });

  it("keeps what a read left standing once the silent stream has spoken, or has outlived its socket's verdict", () => {
    streams();
    runs(10 * MIN);
    reads();
    stateWatch.heard();
    stateWatch.subscription("lost");
    expect(unseen).toEqual(["undated"]);

    streams();
    runs(10 * MIN);
    reads();
    runs(MIN);
    stateWatch.subscription("lost");
    expect(unseen).toEqual(["undated", "undated"]);

    streams();
    runs(10 * SEC);
    stateWatch.subscription("lost");
    expect(unseen).toEqual(["undated", "undated"]);
  });

  it("leaves a later keeper's listener when an earlier one ends", () => {
    const later: UnseenLook[] = [];
    const endLater = stateWatch.keep((look) => { later.push(look); });
    end();
    end = endLater;
    reads();
    sleeps(60 * MIN);
    reads();
    expect(later).toEqual(["first"]);
  });

  it("starts with nothing known and no stream for the page that comes after one that ended", () => {
    streams();
    sleeps(60 * MIN);
    expect(stateWatch.blind()).toBe(true);
    end();
    end = stateWatch.keep((look) => { unseen.push(look); });
    expect(stateWatch.blind()).toBe(false);

    reads();
    runs(2 * MIN);
    expect(stateWatch.blind()).toBe(true);
  });
});
