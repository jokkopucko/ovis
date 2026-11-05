/**
 * The pictures a work line shows at its end (components/ChatView.tsx LineImages): what the tools
 * of a folded work block, or of one row, returned. The Claude app's folded "Read 2 files" line
 * shows them the same way, small, beside the words, so a reader sees what the agent saw without
 * opening anything.
 */
import type { ConversationPart } from "../../shared/protocol.ts";
import type { ToolPart } from "./workBlocks.ts";

/** One picture a tool returned: the tool, the picture's ref and type, and its place among the tool's own. */
export interface WorkImage {
  part: ToolPart;
  ref: string;
  mediaType: string;
  /** 0-based, among this tool's pictures: "Image 2 from Read" */
  ordinal: number;
}

/** How many pictures a line shows; any before them are counted on one "+N" tile, so the line never wraps. */
export const LINE_IMAGES_SHOWN = 4;
/** Beside a finger each thumbnail is a --touch-target square, so fewer fit on the line. */
export const LINE_IMAGES_SHOWN_TOUCH = 3;
/** The room a line preview keeps from the viewport's edges and from its thumbnail. */
export const PREVIEW_MARGIN_PX = 8;

type Box = { top: number; bottom: number; left: number; width: number };

/**
 * Where a preview of `size` goes beside its thumbnail `target`: above it where it fits, else under
 * it, else on the roomier side; centred on the thumbnail and always inside the viewport.
 */
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

/** Every picture the tools among `parts` returned, in the work's order. */
export function workImages(parts: readonly ConversationPart[]): WorkImage[] {
  return parts.flatMap((part) => part.kind !== "tool" || part.images === undefined ? []
    : part.images.map((image, ordinal) => ({ part, ref: image.ref, mediaType: image.media_type, ordinal })));
}

/**
 * The refs the browser keeps once fetched, so a line may fetch their pictures before anything is
 * opened: Claude's (`<entry uuid>:<block>[:<index>]`), pi's (`pi:`, `pi-prompt:`), Grok's
 * (`grok-image:<digest of the bytes>`) and Copilot's (`copilot:<digest of the bytes>`) name bytes
 * that never change, and server/pane-routes.ts serves
 * them immutable. Codex and OpenCode refs are
 * served no-store, and an agent not listed here is taken to be, so their pictures load only when
 * their row is opened (ToolImages).
 */
const CACHED_IMAGE_REFS = [/^[0-9a-f-]{8,64}:\d{1,3}(?::\d{1,3})?$/i, /^pi:/, /^pi-prompt:/, /^grok-image:[a-f0-9]{64}$/, /^copilot:[a-f0-9]{64}$/];

/** Whether the browser keeps the picture `ref` names, so a line may fetch it without a click. */
export function cachedImageRef(ref: string): boolean {
  return CACHED_IMAGE_REFS.some((pattern) => pattern.test(ref));
}

/** The pictures a work line carries: those of `parts` the browser keeps once fetched (cachedImageRef). */
export function linePictures(parts: readonly ConversationPart[]): WorkImage[] {
  return workImages(parts).filter((image) => cachedImageRef(image.ref));
}

/** The pictures a line draws: the latest `shown`, and how many came before them (the "+N" tile). */
export function lineImages<T>(images: readonly T[], shown = LINE_IMAGES_SHOWN): { hidden: number; shown: readonly T[] } {
  if (images.length <= shown) return { hidden: 0, shown: images };
  return { hidden: images.length - shown, shown: images.slice(images.length - shown) };
}
