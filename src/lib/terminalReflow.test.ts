import { describe, expect, it } from "bun:test";
import { selectionText, wrappedRange } from "./ghostty/selection.ts";
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
describe("Ghostty erase above (ED 1 and DECSED 1)", () => {
  it("unwraps the following row when ED clears the cursor's row", async () => {
    const term = await testTerminal({ cols: 5, rows: 3, scrollback: 100 });
    try {
      term.write("p\r\nq\r\nr\r\ns\r\nabcdefgh\x1b[2;5H\x1b[1J");
      const buffer = term.buffer.active;
      const erased = buffer.baseY + 1;
      const following = erased + 1;
      expect(buffer.getLine(following)?.translateToString(true)).toBe("fgh");
      expect(wrappedRange(buffer, following)).toEqual({ first: following, last: following });
      expect(selectionText(buffer, [0, erased], [term.cols, following], false, "\n")).toBe("\nfgh");
      expect(buffer.getLine(erased)?.translateToString(true)).toBe("");
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

  it("unwraps the following row when DECSED clears the cursor's unprotected row", async () => {
    const term = await testTerminal({ cols: 5, rows: 3, scrollback: 100 });
    try {
      term.write("p\r\nq\r\nr\r\ns\r\nabcdefgh\x1b[2;5H\x1b[?1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY + 2)?.translateToString(true)).toBe("fgh");
      expect(buffer.getLine(buffer.baseY + 2)?.isWrapped).toBe(false);
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("");
      expect(buffer.getLine(0)?.translateToString(true)).toBe("p");
    } finally {
      term.dispose();
    }
  });

  it("unwraps the following row when erasing a wide character through the final column", async () => {
    const term = await testTerminal({ cols: 5, rows: 2 });
    try {
      term.write("abc界def\x1b[1;4H\x1b[1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY)?.translateToString(true)).toBe("");
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("def");
      expect(buffer.getLine(buffer.baseY + 1)?.isWrapped).toBe(false);
    } finally {
      term.dispose();
    }
  });

  it("unwraps the following row when an earlier erase already ended the cleared row's own wrap", async () => {
    for (const erase of ["\x1b[1J", "\x1b[?1J"]) {
      const term = await testTerminal({ cols: 5, rows: 2 });
      try {
        // the first erase above clears row 0 and leaves row 1 continuing it; row 0 is redrawn, then erased whole
        term.write(`abcdefgh\x1b[2;1H${erase}\x1b[1;1HXY\x1b[1;5H${erase}`);
        const buffer = term.buffer.active;
        expect(wrappedRange(buffer, 1)).toEqual({ first: 1, last: 1 });
        expect(selectionText(buffer, [0, 0], [term.cols, 1], false, "\n")).toBe("\n gh");
      } finally {
        term.dispose();
      }
    }
  });

  it("keeps the following row wrapped when ED leaves text to the right of the cursor", async () => {
    const term = await testTerminal({ cols: 5, rows: 2 });
    try {
      term.write("abcdefgh\x1b[1;4H\x1b[1J");
      const buffer = term.buffer.active;
      expect(buffer.getLine(buffer.baseY)?.translateToString(true)).toBe("    e");
      expect(buffer.getLine(buffer.baseY + 1)?.isWrapped).toBe(true);
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
