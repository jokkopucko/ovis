import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { userInputTracker } from "./terminalReplies.ts";

/** Every onData of a real xterm, with whether the tracker counted it as someone's input. */
function record(term: Terminal) {
  const tracker = userInputTracker(term);
  const seen: [string, boolean][] = [];
  const data = term.onData((text) => seen.push([text, tracker.wasUserInput()]));
  return { seen, dispose: () => { data.dispose(); tracker.dispose(); } };
}

describe("userInputTracker", () => {
  it("tells xterm's answer to the program's query from input someone made", async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const { seen, dispose } = record(term);
    // a program asking for the cursor's position (DSR 6): xterm answers it on its own
    const { promise, resolve } = Promise.withResolvers<void>();
    term.write("\x1b[6n", resolve);
    await promise;
    term.input("ls\r");
    expect(seen).toEqual([["\x1b[1;1R", false], ["ls\r", true]]);
    dispose();
    term.dispose();
  });

  it("counts everything as typed on an xterm without the signal, as before", () => {
    const tracker = userInputTracker({} as Terminal);
    expect([tracker.wasUserInput(), tracker.wasUserInput()]).toEqual([true, true]);
    tracker.dispose();
  });
});
