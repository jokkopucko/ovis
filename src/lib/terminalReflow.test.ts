import { describe, expect, it } from "bun:test";
import { testTerminal } from "./ghostty/testTerminal.test-support.ts";

// Ovis keeps scrollback 0, so a narrower pane reflows wrapped rows with no history to push them into.
describe("Ghostty reflow with no scrollback", () => {
  it("keeps the viewport inside the buffer when a narrower width pushes the cursor's row to the bottom", async () => {
    const term = await testTerminal({ cols: 40, rows: 5, scrollback: 0 });
    try {
      // three rows of 35 cells, the cursor on the third: at 10 columns each logical line takes four rows
      term.write(["0".repeat(35), "1".repeat(35), "2".repeat(35)].join("\r\n"));
      term.resize(10, 5);
      const buffer = term.buffer.active;
      expect(buffer.baseY + term.rows).toBeLessThanOrEqual(buffer.length);
      expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe("2".repeat(5));

      term.resize(5, 8);
      term.write("\r\n" + "a".repeat(12));
      expect(term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)?.translateToString(true)).toBe("aa");
    } finally {
      term.dispose();
    }
  });
});

// A herdr-core pane keeps its history (scrollback > 0), so the buffer is taller than the screen.
describe("Ghostty erase above (ESC[1J) from a row's last column", () => {
  it("clears the screen through the cursor without erasing the following row or history", async () => {
    const term = await testTerminal({ cols: 5, rows: 3, scrollback: 100 });
    try {
      term.write("p\r\nq\r\nr\r\ns\r\nabcdefgh\x1b[2;5H\x1b[1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 2)?.translateToString(true)).toBe("fgh");
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("");
      expect(buffer.getLine(0)?.translateToString(true)).toBe("p");
    } finally {
      term.dispose();
    }
  });

  it("keeps the row below wrapped when a selective erase (DECSED) leaves the cursor's row protected", async () => {
    const term = await testTerminal({ cols: 5, rows: 3, scrollback: 100 });
    try {
      // abcde is protected (DECSCA), so ESC[?1J leaves it, and fgh still continues it
      term.write("p\r\nq\r\nr\r\ns\r\n\x1b[1\"qabcde\x1b[0\"qfgh\x1b[2;5H\x1b[?1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("abcde");
      expect(buffer.getLine(buffer.baseY + 2)?.isWrapped).toBe(true);
    } finally {
      term.dispose();
    }
  });

  it("clears the cursor's unprotected row while leaving the following text intact", async () => {
    const term = await testTerminal({ cols: 5, rows: 3, scrollback: 100 });
    try {
      term.write("p\r\nq\r\nr\r\ns\r\nabcdefgh\x1b[2;5H\x1b[?1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 2)?.translateToString(true)).toBe("fgh");
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("");
      expect(buffer.getLine(0)?.translateToString(true)).toBe("p");
    } finally {
      term.dispose();
    }
  });

  it("can print again at the cursor after erasing from the last cell", async () => {
    const term = await testTerminal({ cols: 5, rows: 3, scrollback: 100 });
    try {
      term.write("1\r\n2\r\n33333\x1b[1J");
      term.write("z");
      expect(term.buffer.active.getLine(2)?.translateToString(true)).toBe("    z");
      expect(term.buffer.active.baseY).toBe(0);
    } finally {
      term.dispose();
    }
  });
});
