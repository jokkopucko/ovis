import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { patchedTerminal } from "../../scripts/build-xterm.ts";

const Terminal = await patchedTerminal(join(import.meta.dir, "../.."));

type Term = InstanceType<typeof Terminal>;
const write = (term: Term, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));

// Ovis keeps scrollback 0, so a narrower pane reflows wrapped rows with no history to push them into.
describe("xterm reflow with no scrollback", () => {
  it("keeps the viewport inside the buffer when a narrower width pushes the cursor's row to the bottom", async () => {
    const term = new Terminal({ cols: 40, rows: 5, scrollback: 0, allowProposedApi: true });
    try {
      // three rows of 35 cells, the cursor on the third: at 10 columns the first two take four rows each
      // (xterm leaves the cursor's own row unwrapped)
      await write(term, ["0".repeat(35), "1".repeat(35), "2".repeat(35)].join("\r\n"));
      term.resize(10, 5);
      const buffer = term.buffer.active;
      expect(buffer.baseY + term.rows).toBeLessThanOrEqual(buffer.length);
      expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe("2".repeat(10));

      term.resize(5, 8);
      await write(term, "\r\n" + "a".repeat(12));
      expect(term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)?.translateToString(true)).toBe("aa");
    } finally {
      term.dispose();
    }
  });
});

// A herdr-core pane keeps its history (scrollback > 0), so the buffer is taller than the screen.
describe("xterm erase above (ESC[1J) from a row's last column", () => {
  it("unwraps the screen row below the cursor, not a history row", async () => {
    const term = new Terminal({ cols: 5, rows: 3, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "p\r\nq\r\nr\r\ns\r\nabcdefgh\x1b[2;5H\x1b[1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 2)?.translateToString(true)).toBe("fgh");
      expect(buffer.getLine(buffer.baseY + 2)?.isWrapped).toBe(false);
    } finally {
      term.dispose();
    }
  });

  it("keeps the row below wrapped when a selective erase (DECSED) leaves the cursor's row protected", async () => {
    const term = new Terminal({ cols: 5, rows: 3, scrollback: 100, allowProposedApi: true });
    try {
      // abcde is protected (DECSCA), so ESC[?1J leaves it, and fgh still continues it
      await write(term, "p\r\nq\r\nr\r\ns\r\n\x1b[1\"qabcde\x1b[0\"qfgh\x1b[2;5H\x1b[?1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("abcde");
      expect(buffer.getLine(buffer.baseY + 2)?.isWrapped).toBe(true);
    } finally {
      term.dispose();
    }
  });

  it("unwraps the row below when a selective erase (DECSED) clears the cursor's row whole", async () => {
    const term = new Terminal({ cols: 5, rows: 3, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "p\r\nq\r\nr\r\ns\r\nabcdefgh\x1b[2;5H\x1b[?1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("");
      expect(buffer.getLine(buffer.baseY + 2)?.isWrapped).toBe(false);
    } finally {
      term.dispose();
    }
  });

  it("leaves nothing to unwrap from the screen's last row", async () => {
    const term = new Terminal({ cols: 5, rows: 3, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "1\r\n2\r\n33333\x1b[1J");
      await write(term, "z");
      expect(term.buffer.active.getLine(2)?.translateToString(true)).toBe("");
    } finally {
      term.dispose();
    }
  });
});
