/**
 * Safari before 16.4 cannot parse a lookbehind (`(?<` then `=` or `!`), and one in a module stops the
 * whole app from loading there (#2534). So no pattern of the client has one: the character before
 * a match is matched with it (`(?:^|[^…])(…)`, the match proper a group) where that character can
 * never be the end of the match before, or else asked about in code, with `charBefore`.
 */

/** The character that ends before `index`, a surrogate pair as one; "" at the start of the text. */
export function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.charAt(index - 1);
}
