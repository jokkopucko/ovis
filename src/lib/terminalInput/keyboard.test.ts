import { expect, test } from "bun:test";
import { evaluateKeyboardEvent } from "./keyboard.ts";

// Bytes captured from the patched xterm.js 6.0.0 evaluator.
const cases: readonly (readonly [string | undefined, number, number?, boolean?, boolean?, boolean?, string?, string?])[] = [
  ["\x1b[D", 37, 0, false],
  ["\x1bOD", 37, 0, true],
  ["\x1b[A", 38, 0, false],
  ["\x1bOA", 38, 0, true],
  ["\x1b[C", 39, 0, false],
  ["\x1bOC", 39, 0, true],
  ["\x1b[B", 40, 0, false],
  ["\x1bOB", 40, 0, true],
  ["\x1b[H", 36, 0, false],
  ["\x1bOH", 36, 0, true],
  ["\x1b[F", 35, 0, false],
  ["\x1bOF", 35, 0, true],
  ["\x1bOP", 112],
  ["\x1bOQ", 113],
  ["\x1bOR", 114],
  ["\x1bOS", 115],
  ["\x1b[15~", 116],
  ["\x1b[17~", 117],
  ["\x1b[18~", 118],
  ["\x1b[19~", 119],
  ["\x1b[20~", 120],
  ["\x1b[21~", 121],
  ["\x1b[23~", 122],
  ["\x1b[24~", 123],
  ["\x01", 65, 4],
  ["\x03", 67, 4],
  ["\x1a", 90, 4],
  ["\x00", 32, 4],
  ["\x1ba", 65, 2],
  [undefined, 65, 2, false, true],
  ["\x1ba", 65, 2, false, true, true],
  ["\x1b[1;5D", 37, 2, false, false],
  ["\x1bb", 37, 2, false, true],
  ["\x1b[1;5C", 39, 2, false, false],
  ["\x1bf", 39, 2, false, true],
  ["\x1b[Z", 9, 1],
  ["\x7f", 8],
  ["\b", 8, 4],
  ["\x1b\x7f", 8, 2],
  ["\r", 13],
  ["\x1b\r", 13, 2],
  ["\x1b", 27],
  ["\x1b\x1b", 27, 2],
  ["1", 97, 0, false, false, false, "1", "Numpad1"],
  ["+", 107, 0, false, false, false, "+", "NumpadAdd"],
  ["\r", 13, 0, false, false, false, "Enter", "NumpadEnter"],
  ["\x1bOD", 0, 0, true, false, false, "UIKeyInputLeftArrow"],
];

for (const [expected, keyCode, modifiers = 0, applicationCursor = false, mac = false, optionIsMeta = false, key = "", code = ""] of cases) {
  test(`keyCode ${keyCode} (${code || key || "legacy"}), modifiers ${modifiers}, application cursor ${applicationCursor}, Mac ${mac}, Option as Meta ${optionIsMeta}`, () => {
    const event = { keyCode, key, code, shiftKey: !!(modifiers & 1), altKey: !!(modifiers & 2), ctrlKey: !!(modifiers & 4), metaKey: false };
    expect(evaluateKeyboardEvent(event, applicationCursor, mac, optionIsMeta).key).toBe(expected);
  });
}
