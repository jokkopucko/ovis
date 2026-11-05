/**
 * The pure part of the chat's image viewer (components/ImageLightbox.tsx): which picture of a
 * message's gallery a step lands on, what the keys do, what the bar says the zoom is, and the
 * name a saved picture gets. The zoom arithmetic itself is MermaidLightbox's `zoomAt`.
 */

/** One picture of a chat message: a user's attachment, an `@path` mention, a tool result or a local Markdown image. */
export interface GalleryImage {
  src: string;
  /** what the caption and the alt text say: the mentioned path, Markdown alt text, or "Attached image" */
  name: string;
  /** the name a download gets */
  file: string;
}

/** The gallery index `index` steps to, wrapping at both ends (-1 is the last picture). */
export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

/**
 * The zoom the bar shows, in the picture's own pixels: `scale` is the view's factor over the
 * fitted picture, `fit` the fitted picture's size over its natural size (1 for a picture that is
 * smaller than the stage; unknown before it has loaded, when 1 reads as the factor over fit).
 */
export function zoomPercent(scale: number, fit: number): number {
  return Math.round(scale * (fit > 0 ? fit : 1) * 100);
}

/**
 * The factor a double-click zooms a fitted picture by: to its natural pixels when the stage had
 * to shrink it, else twice its size, so the gesture always shows more than fit did.
 */
export function actualSizeFactor(fit: number): number {
  return fit > 0 ? Math.max(2, 1 / fit) : 2;
}

export type ArrowAction = { kind: "pan"; dx: number; dy: number } | { kind: "step"; by: -1 | 1 };

/**
 * What an arrow key does: a zoomed picture pans by `step` stage pixels (the view moves the way
 * the content would scroll, as MermaidLightbox's keys do); at fit the whole picture is in view,
 * so Left and Right step through the gallery when it has more than one picture. Any other key,
 * or a vertical arrow at fit, is nobody's.
 */
export function arrowAction(key: string, zoomed: boolean, count: number, step: number): ArrowAction | null {
  if (zoomed) {
    switch (key) {
      case "ArrowLeft": return { kind: "pan", dx: step, dy: 0 };
      case "ArrowRight": return { kind: "pan", dx: -step, dy: 0 };
      case "ArrowUp": return { kind: "pan", dx: 0, dy: step };
      case "ArrowDown": return { kind: "pan", dx: 0, dy: -step };
      default: return null;
    }
  }
  if (count <= 1) return null;
  if (key === "ArrowLeft") return { kind: "step", by: -1 };
  if (key === "ArrowRight") return { kind: "step", by: 1 };
  return null;
}

const EXTENSIONS: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg" };

/**
 * A download name for the `ordinal`th attachment of a message (0-based), from its media type:
 * `image-1.png`, `image-2.jpg`. A type without a subtype, or none, reads as PNG, what a paste
 * nearly always is.
 */
export function attachmentFileName(mediaType: string, ordinal: number): string {
  const subtype = /^image\/([\w.+-]+)/i.exec(mediaType)?.[1]?.toLowerCase() ?? "png";
  return `image-${ordinal + 1}.${EXTENSIONS[subtype] ?? subtype}`;
}

/** The download name of an `@path` mention: its last segment, whichever way the path is written. */
export function mentionFileName(path: string): string {
  const name = path.split(/[\\/]/).filter((segment) => segment.length > 0).at(-1);
  return name === undefined || name.length === 0 ? "image" : name;
}
