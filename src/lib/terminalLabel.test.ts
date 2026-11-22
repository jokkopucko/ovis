import { describe, expect, it } from "bun:test";

import { terminalLabel } from "./terminalLabel.ts";

const t = (key: string, vars?: Record<string, string | number>): string =>
  key.replace("{title}", String(vars?.["title"]));

describe("the terminal's accessible name", () => {
  it("names the region after the pane", () => {
    expect(terminalLabel("p_1", "Idempotent payments", t)).toBe("Terminal for Idempotent payments");
    expect(terminalLabel("p_1", "  build  ", t)).toBe("Terminal for build");
  });

  it("never reads a pane id out as a name", () => {
    expect(terminalLabel(null, null, t)).toBe("Terminal");
    expect(terminalLabel(null, "Idempotent payments", t)).toBe("Terminal");
    // a pane open before the snapshot that titles it: an id here would be read aloud
    expect(terminalLabel("p_1a2b3c4d", null, t)).toBe("Terminal");
    expect(terminalLabel("p_1a2b3c4d", "", t)).toBe("Terminal");
    expect(terminalLabel("p_1a2b3c4d", "   ", t)).toBe("Terminal");
    expect(terminalLabel("w1:p2", "w1:p2", t)).toBe("Terminal");
  });
});
