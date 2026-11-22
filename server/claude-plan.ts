import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The plan behind Claude Code's "Ready to code?" dialog, read whole from Claude's plan file.
 *
 * The screen shows only the part of a plan that fits the pane, and the `ExitPlanMode` call reaches
 * the transcript only with its answer (#211). The plan file is there in time: Claude writes it to
 * `<config dir>/plans/<slug>.md` before it asks, and every message line carries the session's
 * `"slug"`. The transcript is `<config dir>/projects/<project>/<session>.jsonl`, so its config
 * dir, `CLAUDE_CONFIG_DIR` or not, is three levels up.
 *
 * The tail is 1 MB: recent Claude Code versions write request lines of 70 to 145 KB without the
 * slug (`api-request`, `api-request-blob`), and the dialog can come after several of them.
 */
const TAIL_BYTES = 1024 * 1024;
const SLUG_RE = /"slug":"([^"]*)"/g;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function claudePlanFile(transcript: string): Promise<{ path: string; text: string } | null> {
  try {
    const slug = await lastSlug(transcript);
    if (slug === null || !SAFE_SLUG.test(slug)) return null;
    const path = join(dirname(dirname(dirname(transcript))), "plans", `${slug}.md`);
    const text = await readFile(path, "utf8");
    return text.trim() ? { path, text } : null;
  } catch {
    return null;
  }
}

/** The last `"slug"` in the transcript's tail: the session's current one. */
async function lastSlug(transcript: string): Promise<string | null> {
  const file = await open(transcript, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    let slug: string | null = null;
    for (const match of buffer.toString("utf8").matchAll(SLUG_RE)) slug = match[1]!;
    return slug;
  } finally {
    await file.close();
  }
}
