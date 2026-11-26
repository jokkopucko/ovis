import { describe, expect, test } from "bun:test";
import type { CompositionEvent, InputEvent } from "react";

import { endPairCodeComposition, typePairCode } from "./pairCodeInput.ts";

const fieldAt = (value: string, caret: number) => {
  const field = {
    value, selectionStart: caret, selectionEnd: caret, maxLength: 32,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    ownerDocument: {
      execCommand(command: string, _showUI: boolean, text: string): boolean {
        if (command !== "insertText") return false;
        const { value, selectionStart, selectionEnd } = field;
        field.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
        return true;
      },
    },
  };
  return field;
};

const typed = (value: string, { caret = value.length, inputType = "insertText", isComposing = false } = {}): string => {
  const field = fieldAt(value, caret);
  typePairCode({ currentTarget: field, nativeEvent: { inputType, isComposing } } as unknown as InputEvent<HTMLInputElement>);
  return field.value;
};

const composed = (value: string, caret = value.length): string => {
  const field = fieldAt(value, caret);
  endPairCodeComposition({ currentTarget: field } as unknown as CompositionEvent<HTMLInputElement>);
  return field.value;
};

describe("typePairCode", () => {
  test("puts the dash in after the fifth character typed at the end", () => {
    expect(typed("ab3de")).toBe("AB3DE-");
    expect(typed("AB3DE-f")).toBe("AB3DE-F");
  });

  test("leaves the dash deleted by Backspace", () => {
    expect(typed("AB3DE", { inputType: "deleteContentBackward" })).toBe("AB3DE");
  });

  test("leaves the field alone while the caret is back in the code", () => {
    expect(typed("ab3de", { caret: 2 })).toBe("ab3de");
  });

  test("leaves the field alone while a keyboard composes a word", () => {
    expect(typed("ab3de", { isComposing: true })).toBe("ab3de");
  });

  test.each(["historyUndo", "historyRedo"])("leaves the value restored by %s alone", (inputType) => {
    expect(typed("ab3de", { inputType })).toBe("ab3de");
  });
});

describe("endPairCodeComposition", () => {
  test("puts the dash and the capitals into a word the keyboard committed at the end", () => {
    expect(composed("ab3de")).toBe("AB3DE-");
    expect(composed("AB3DE-fg")).toBe("AB3DE-FG");
  });

  test("leaves the field alone while the caret is back in the code", () => {
    expect(composed("ab3de", 2)).toBe("ab3de");
  });
});
