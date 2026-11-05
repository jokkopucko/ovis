import { machinePath } from "../../shared/machines.ts";
import type { ConversationPart } from "../../shared/protocol.ts";
import { fileUrl } from "./api.ts";
import type { Translate } from "./i18n.ts";
import { attachmentFileName, mentionFileName } from "./imageViewer.ts";
import type { GalleryImage } from "./imageViewer.ts";
import type { WorkImage } from "./workImages.ts";

/** A tool's picture as the viewer shows it, fetched from the conversation by its ref. */
export function toolGalleryImage(machineId: string, paneId: string, image: WorkImage, t: Translate): GalleryImage {
  return {
    src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: image.ref }).toString()}`),
    name: t("Image {n} from {tool}", { n: image.ordinal + 1, tool: image.part.name }),
    file: attachmentFileName(image.mediaType, image.ordinal),
  };
}

/** Pasted pictures first, then image files mentioned as @path, in the message's order. */
export function userGalleryImages(machineId: string, paneId: string, parts: readonly ConversationPart[], text: string, t: Translate): GalleryImage[] {
  const pasted = parts.filter((part): part is Extract<ConversationPart, { kind: "image" }> => part.kind === "image");
  // Uploads insert an unquoted absolute path, and the pane's cwd may hold spaces (an iCloud folder).
  // A path with spaces counts only in the shape an upload takes (server/paste.ts: `<name>-<YYYYMMDD>-
  // <HHMMSS>-<8 hex>.<ext>`), so prose after another @mention never reads as a file; it stops at a
  // line break, the next mention or path (a folder's " @" followed by a space is part of it), as
  // lib/tabLabels.ts reads it, and is bounded so a long line stays quick to scan. Only an upload in its
  // folder `.ovis` may run past a word ending in an image's extension (#2682). It is tried first, so a
  // spaced folder named like an image never ends the upload's path early.
  const mentioned = [...new Set([...text.matchAll(/(?:^|\s)@((?:\/|[a-z]:[\\/])(?:(?:(?!\s(?:@\S|[\\/]|~[\\/]|[a-z]:[\\/]))[^\r\n\t]){0,1024}?[\\/]\.ovis[\\/][^\s\\/]*-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpe?g|gif|webp)(?=\s|$)|(?:(?!\s(?:@\S|[\\/]|~[\\/]|[a-z]:[\\/])|\.(?:png|jpe?g|gif|webp)\s)[^\r\n\t]){0,1024}?[\\/][^\s\\/]*-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpe?g|gif|webp)(?=\s|$))|\S+\.(?:png|jpe?g|gif|webp)(?=\s|$))/gi)].map((match) => match[1] ?? ""))];
  return [
    ...pasted.map((part, index): GalleryImage => ({
      src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: part.ref }).toString()}`),
      name: t("Attached image"),
      file: attachmentFileName(part.media_type, index),
    })),
    ...mentioned.map((path): GalleryImage => ({ src: fileUrl(path, paneId, machineId), name: path, file: mentionFileName(path) })),
  ];
}
