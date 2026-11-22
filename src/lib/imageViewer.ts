export interface GalleryImage {
  src: string;
  name: string;
  file: string;
}

export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export function zoomPercent(scale: number, fit: number): number {
  return Math.round(scale * (fit > 0 ? fit : 1) * 100);
}

export function actualSizeFactor(fit: number): number {
  return fit > 0 ? Math.max(2, 1 / fit) : 2;
}

export type ArrowAction = { kind: "pan"; dx: number; dy: number } | { kind: "step"; by: -1 | 1 };

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

export function attachmentFileName(mediaType: string, ordinal: number): string {
  const subtype = /^image\/([\w.+-]+)/i.exec(mediaType)?.[1]?.toLowerCase() ?? "png";
  return `image-${ordinal + 1}.${EXTENSIONS[subtype] ?? subtype}`;
}

export function mentionFileName(path: string): string {
  const name = path.split(/[\\/]/).filter((segment) => segment.length > 0).at(-1);
  return name === undefined || name.length === 0 ? "image" : name;
}
