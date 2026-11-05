import { getTransport } from "./transport.ts";

/** Whether a picture can go on the clipboard here: only the clipboard API takes one, and only in a secure context. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copies a picture the page has shown. The clipboard takes PNG alone, so a PNG goes as its own
 * bytes (the browser has them cached) and anything else is drawn on a canvas and encoded. The
 * clipboard item is made in the click itself and the bytes follow: Safari refuses a write that
 * begins after the gesture is over. Returns whether the picture is on the clipboard.
 */
export async function copyImage(image: HTMLImageElement): Promise<boolean> {
  if (!canCopyImage()) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(image) })]);
    return true;
  } catch {
    return false;
  }
}

async function pngOf(image: HTMLImageElement): Promise<Blob> {
  try {
    const response = await getTransport().fetch(image.currentSrc);
    const blob = await response.blob();
    if (response.ok && blob.type.split(";", 1)[0] === "image/png") return blob;
  } catch {
    /* the bytes could not be read again: the decoded picture is drawn instead */
  }
  if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error("image not decoded");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png encoding failed"))), "image/png");
  });
}

/** Selects everything inside `node`, so the user can long-press or Ctrl+C it. */
export function selectContents(node: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Copies text. The clipboard API exists only in secure contexts (HTTPS or localhost), so on a
 * plain-HTTP LAN address it tries the browser's copy command. If copying is refused, it
 * selects the given node instead, ready for a long press or Ctrl+C.
 * Returns whether the text is on the clipboard.
 */
export async function copyText(text: string, fallback?: HTMLElement | null): Promise<boolean> {
  const initiator = document.activeElement;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* no clipboard API here, or the browser refused */
  }
  // A refusal can come late. If focus has moved on by then, the user is elsewhere (the message box,
  // a terminal, perhaps mid-IME): taking focus to copy would cut into what they are typing.
  if (document.activeElement !== initiator) return false;
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  let copied = false;
  try {
    input.focus({ preventScroll: true });
    input.select();
    copied = document.execCommand("copy");
  } catch {
    /* the legacy copy command can be refused too */
  } finally {
    input.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (inputSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && inputSelection.start !== null && inputSelection.end !== null) {
      active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    }
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
  if (copied) return true;
  if (fallback instanceof HTMLTextAreaElement || fallback instanceof HTMLInputElement) {
    fallback.focus();
    fallback.select();
  } else if (fallback) {
    selectContents(fallback);
  }
  return false;
}
