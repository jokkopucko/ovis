import type { CompositionEvent, InputEvent } from "react";

import { typedPairCode } from "../../shared/relay-pair-code.ts";

function formatField(field: HTMLInputElement, deleting: boolean): void {
  const value = field.value;
  const formatted = typedPairCode(value, deleting);
  if (formatted === value || (field.maxLength >= 0 && formatted.length > field.maxLength)) return;
  // Replace only the changed suffix through the browser editor, not the value setter, to preserve undo.
  let start = 0;
  for (const char of value) {
    if (!formatted.startsWith(char, start)) break;
    start += char.length;
  }
  field.setSelectionRange(start, value.length);
  if (!field.ownerDocument.execCommand("insertText", false, formatted.slice(start))) field.setSelectionRange(value.length, value.length);
}

/**
 * The `onInput` of a field a pairing code is typed in. It reformats only while typing at the end, so a caret moved back
 * stays where it was, and never during a keyboard's composition, whose word the field would otherwise get twice.
 */
export function typePairCode(event: InputEvent<HTMLInputElement>): void {
  const field = event.currentTarget, input = event.nativeEvent;
  if (input.isComposing || field.selectionStart !== field.value.length) return;
  if (input.inputType?.startsWith("insert")) formatField(field, false);
  else if (input.inputType?.startsWith("delete")) formatField(field, true);
}

/** The same field's `onCompositionEnd`: Chrome fires no input event after a composed word is committed. */
export function endPairCodeComposition(event: CompositionEvent<HTMLInputElement>): void {
  const field = event.currentTarget;
  if (field.selectionStart === field.value.length) formatField(field, false);
}
