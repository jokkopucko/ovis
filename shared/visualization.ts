/** A complete Codex visualization reference on its own line; malformed/streaming text stays text. */
export interface VisualizationReference {
  path: string;
  title?: string;
  wide: boolean;
}

/**
 * What a card shows of a name or a title an agent wrote: no bidi control or other invisible format character
 * (they reorder or hide what is read), every run of spaces and control characters one space, and at most `limit`
 * characters, cut in the middle so the end (a file's type) stays.
 */
function shown(text: string, limit: number): string {
  const clean = [...text.replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim()];
  return clean.length <= limit ? clean.join("") : `${clean.slice(0, limit - 17).join("")}\u2026${clean.slice(-16).join("")}`;
}

/** The file's own name as its card shows it: always the path's last part, never what the reference calls it. */
export function visualizationName(path: string): string {
  return shown(path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1), 80);
}

/** The reference's title as its card's second line; null when it has none, or it only repeats the file's name. */
export function visualizationTitle(reference: Pick<VisualizationReference, "path" | "title">): string | null {
  const title = reference.title === undefined ? "" : shown(reference.title, 120);
  return title === "" || title === visualizationName(reference.path) ? null : title;
}

export function visualizationReference(line: string): VisualizationReference | null {
  const value = line.trim();
  if (value.length > 16_384 || !value.startsWith("\uE200visualize\uE202") || !value.endsWith("\uE201")) return null;
  try {
    const data: unknown = JSON.parse(value.slice(11, -1));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const { path, title, mode } = data as Record<string, unknown>;
    // an absolute local path, never a network share however its two leading separators are written
    // (`//host`, `/\host`): the preview looks the file up by itself, and on a Windows PC that lookup
    // would reach out to the share
    if (typeof path !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(path) || /^[\\/]{2}/.test(path)
      || /[\x00-\x1f\x7f]/.test(path) || !/\.html?$/i.test(path)
      || (mode !== undefined && mode !== "wide")
      || (title !== undefined && (typeof title !== "string" || title.length > 200))) return null;
    return { path, ...(typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}), wide: mode === "wide" };
  } catch { return null; }
}
