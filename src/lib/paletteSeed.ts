export function paletteOpenQuery(query: unknown): string {
  return typeof query === "string" ? query : "";
}
