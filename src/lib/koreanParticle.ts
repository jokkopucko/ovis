const DIGIT_ENDS_IN_CONSONANT = new Set(["0", "1", "3", "6", "7", "8"]);
const LATIN_ENDS_IN_CONSONANT = new Set(["b", "c", "g", "k", "l", "m", "n", "p", "t"]);

export function objectParticle(name: string): "을" | "를" {
  const last = [...name].reverse().find((char) => /[\p{L}\p{N}]/u.test(char));
  if (last === undefined) return "를";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  if (/\d/.test(last)) return DIGIT_ENDS_IN_CONSONANT.has(last) ? "을" : "를";
  return LATIN_ENDS_IN_CONSONANT.has(last.toLowerCase()) ? "을" : "를";
}
