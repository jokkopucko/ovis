export interface SendUserFileCall {
  caption: string;
  files: string[];
}

export function sendUserFileCall(input: Record<string, unknown>): SendUserFileCall | null {
  if (!Array.isArray(input["files"])) return null;
  const files = input["files"].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (files.length === 0) return null;
  const caption = typeof input["caption"] === "string" ? input["caption"].trim() : "";
  return { caption, files };
}
