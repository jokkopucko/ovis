const OTHER_CONTROL = /\p{C}/gu;

/**
 * Unknown agent labels can contain private-use Nerd Font glyphs. They are data,
 * not a usable fallback initial, so remove them before drawing the fallback mark.
 */
export function fallbackInitial(agent: string): string {
  const clean = agent.normalize("NFKC").replace(OTHER_CONTROL, "").trim();
  return [...clean][0]?.toUpperCase() ?? "?";
}

const MARK_HUES = ["keyword", "string", "number", "type", "variable", "meta"] as const;

export function fallbackHue(agent: string): (typeof MARK_HUES)[number] {
  let hash = 0;
  for (const char of agent.normalize("NFKC").trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return MARK_HUES[hash % MARK_HUES.length]!;
}
