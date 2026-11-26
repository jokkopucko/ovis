// Copyright (c) The xterm.js authors. MIT License.
// Adapted for Ovis.

export function prepareTextForTerminal(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

export function bracketTextForPaste(text: string, enabled: boolean): string {
  return enabled ? "\x1b[200~" + text + "\x1b[201~" : text;
}

export function paste(text: string, textarea: HTMLTextAreaElement, bracketed: boolean, send: (text: string) => void): void {
  send(bracketTextForPaste(prepareTextForTerminal(text), bracketed));
  textarea.value = "";
}

export function handlePasteEvent(event: ClipboardEvent, pasteText: (text: string) => void): void {
  event.stopPropagation();
  if (event.clipboardData) pasteText(event.clipboardData.getData("text/plain"));
}

export function moveTextAreaUnderMouseCursor(event: MouseEvent, textarea: HTMLTextAreaElement, screen: HTMLElement): void {
  const rect = screen.getBoundingClientRect();
  Object.assign(textarea.style, {
    width: "20px", height: "20px", left: (event.clientX - rect.left - 10) + "px",
    top: (event.clientY - rect.top - 10) + "px", zIndex: "1000",
  });
  textarea.focus();
}

export function rightClickHandler(
  event: MouseEvent, textarea: HTMLTextAreaElement, screen: HTMLElement,
  selectionText?: () => string, selectWordAt?: (event: MouseEvent) => void,
): void {
  moveTextAreaUnderMouseCursor(event, textarea, screen);
  selectWordAt?.(event);
  textarea.value = selectionText?.() ?? "";
  textarea.select();
}
