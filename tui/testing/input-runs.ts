import { expect } from "bun:test";
import type { InputEvent } from "../input/decode.ts";
import { Framer } from "../input/framer.ts";

export const T0 = 1_000;
/** How far apart two reads of a run are: less than any wait, so no deadline passes between them. */
const READ_GAP_MS = 1;
/** Long enough after the last read for every wait to have passed. */
const SETTLE_MS = 60_000;

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export const raw = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/**
 * Events without their stamps, adjacent text joined. A text run is cut where its read is cut (text is
 * never held back), so a cut changes how the text is split into events but never the text itself.
 */
export function normalize(events: readonly InputEvent[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  for (const { at: _at, ...event } of events) {
    const last = out.at(-1);
    if (event.type === "text" && last?.type === "text") last.text = `${last.text as string}${event.text}`;
    else out.push({ ...event });
  }
  return out;
}

/** Feeds the reads READ_GAP_MS apart from T0, then lets every wait pass. */
export function feedReads(reads: readonly Uint8Array[], setup?: (framer: Framer) => void): InputEvent[] {
  const framer = new Framer();
  setup?.(framer);
  const events: InputEvent[] = [];
  let now = T0;
  for (const read of reads) {
    events.push(...framer.feed(read, now));
    now += READ_GAP_MS;
  }
  events.push(...framer.tick(now + SETTLE_MS));
  return events;
}

type WayKind = "whole" | "cut" | "byte by byte";

/** The ways one input is read: whole, cut in two at every offset (0 to its length), and byte by byte. */
export function readWays(input: Uint8Array): { kind: WayKind; name: string; reads: Uint8Array[] }[] {
  const ways: { kind: WayKind; name: string; reads: Uint8Array[] }[] = [{ kind: "whole", name: "whole", reads: [input] }];
  for (let cut = 0; cut <= input.length; cut++) ways.push({ kind: "cut", name: `cut at ${cut}`, reads: [input.subarray(0, cut), input.subarray(cut)] });
  ways.push({ kind: "byte by byte", name: "byte by byte", reads: Array.from(input, (_, i) => input.subarray(i, i + 1)) });
  return ways;
}

/**
 * Runs `input` every way it can be read and expects the same events each time. Fails unless all three
 * kinds ran: once whole, once cut at each of the `input.length + 1` offsets, once byte by byte. In the whole run every event read from the bytes carries the stamp of that one
 * read (a probe's timeout is stamped with the end of its wait).
 */
export function expectEveryWay(input: Uint8Array, expected: unknown[], setup?: (framer: Framer) => void): void {
  const ran: Record<WayKind, number> = { whole: 0, cut: 0, "byte by byte": 0 };
  for (const { kind, name, reads } of readWays(input)) {
    const events = feedReads(reads, setup);
    expect({ way: name, events: normalize(events) }).toEqual({ way: name, events: expected });
    if (name === "whole") {
      const read = events.filter((event) => !(event.type === "reply" && event.kind === "timeout"));
      expect(read.map((event) => event.at)).toEqual(read.map(() => T0));
    }
    ran[kind]++;
  }
  expect({ ways: ran }).toEqual({ ways: { whole: 1, cut: input.length + 1, "byte by byte": 1 } });
}
