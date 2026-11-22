/**
 * What a server offers only as a preview: `OVIS_PREVIEW`, a comma-separated list of words, read here and nowhere else.
 * No release sets it. `fleet`, the only word: the machine profile (OVIS_PROFILE=machine) starts. Like OVIS_PROFILE it is
 * a label anyone who starts the server can set, not a security boundary.
 */
export function fleetPreview(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env["OVIS_PREVIEW"] ?? "").split(",").some((word) => word.trim() === "fleet");
}
