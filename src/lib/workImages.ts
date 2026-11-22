import type { ConversationPart } from "../../shared/protocol.ts";
import type { ToolPart } from "./workBlocks.ts";

export interface WorkImage {
  part: ToolPart;
  ref: string;
  mediaType: string;
  ordinal: number;
}

export const LINE_IMAGES_SHOWN = 4;
export const LINE_IMAGES_SHOWN_TOUCH = 3;
export const PREVIEW_MARGIN_PX = 8;

type Box = { top: number; bottom: number; left: number; width: number };

export function previewPlace(target: Box, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  const edge = PREVIEW_MARGIN_PX;
  const roomAbove = target.top - 2 * edge;
  const roomBelow = viewport.height - target.bottom - 2 * edge;
  const up = size.height <= roomAbove || (size.height > roomBelow && roomAbove > roomBelow);
  const top = up ? target.top - edge - size.height : target.bottom + edge;
  return {
    left: Math.max(edge, Math.min(target.left + target.width / 2 - size.width / 2, viewport.width - size.width - edge)),
    top: Math.max(edge, Math.min(top, viewport.height - size.height - edge)),
  };
}

export function workImages(parts: readonly ConversationPart[]): WorkImage[] {
  return parts.flatMap((part) => part.kind !== "tool" || part.images === undefined ? []
    : part.images.map((image, ordinal) => ({ part, ref: image.ref, mediaType: image.media_type, ordinal })));
}

const CACHED_IMAGE_REFS = [/^[0-9a-f-]{8,64}:\d{1,3}(?::\d{1,3})?$/i, /^pi:/, /^pi-prompt:/, /^grok-image:[a-f0-9]{64}$/, /^copilot:[a-f0-9]{64}$/];

export function cachedImageRef(ref: string): boolean {
  return CACHED_IMAGE_REFS.some((pattern) => pattern.test(ref));
}

export function linePictures(parts: readonly ConversationPart[]): WorkImage[] {
  return workImages(parts).filter((image) => cachedImageRef(image.ref));
}

export function lineImages<T>(images: readonly T[], shown = LINE_IMAGES_SHOWN): { hidden: number; shown: readonly T[] } {
  if (images.length <= shown) return { hidden: 0, shown: images };
  return { hidden: images.length - shown, shown: images.slice(images.length - shown) };
}
