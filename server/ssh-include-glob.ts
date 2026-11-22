/**
 * One path component of an ssh config Include, as glob(3) reads it (server/ssh-include.ts): `*`, `?`, a bracket
 * expression of single characters and plain ranges (`[ab]`, `[!a-z]`), and backslash escapes where the platform has
 * them. ssh passes no GLOB_BRACE, so `{a,b}` is literal. What is not matched exactly here (a POSIX class `[[:digit:]]`,
 * an equivalence or collating element, a `^` negation, an escape inside brackets, a range whose order depends on the
 * locale, a bracket left open, a trailing backslash) parses to null, so the Include is left unread, never guessed.
 */

export type Token = { kind: "char"; char: string } | { kind: "one" } | { kind: "star" } | { kind: "class"; negate: boolean; ranges: [string, string][] };

/** both ends of a range a digit, a lowercase or an uppercase ASCII letter alike: ordered the same in every locale */
const plainRange = (from: string, to: string): boolean => [/[0-9]/, /[a-z]/, /[A-Z]/].some((kind) => kind.test(from) && kind.test(to)) && from <= to;

function bracket(chars: string[], start: number): { token: Token; next: number } | "open" | null {
  let index = start;
  const negate = chars[index] === "!";
  if (negate) index++;
  if (chars[index] === "^") return null;
  const ranges: [string, string][] = [];
  for (let first = true; index < chars.length; first = false) {
    const char = chars[index]!;
    if (char === "]" && !first) return { token: { kind: "class", negate, ranges }, next: index + 1 };
    if (char === "\\" || (char === "[" && /[:=.]/.test(chars[index + 1] ?? ""))) return null;
    if (chars[index + 1] === "-" && chars[index + 2] !== undefined && chars[index + 2] !== "]") {
      if (!plainRange(char, chars[index + 2]!)) return null;
      ranges.push([char, chars[index + 2]!]);
      index += 3;
    } else { ranges.push([char, char]); index++; }
  }
  return "open";
}

export function parseComponent(raw: string, escapes: boolean): { name: string } | { tokens: Token[] } | null {
  const chars = Array.from(raw);
  const tokens: Token[] = [];
  for (let index = 0; index < chars.length;) {
    const char = chars[index]!;
    if (escapes && char === "\\") {
      if (index + 1 >= chars.length) return null;
      tokens.push({ kind: "char", char: chars[index + 1]! });
      index += 2;
    } else if (char === "*" || char === "?") { tokens.push({ kind: char === "*" ? "star" : "one" }); index++; }
    else if (char === "[") {
      const found = bracket(chars, index + 1);
      if (found === null) return null;
      // glibc's glob reads a `[` no `]` closes as itself (a home folder named `alice[work`)
      if (found === "open") { tokens.push({ kind: "char", char }); index++; continue; }
      tokens.push(found.token);
      index = found.next;
    } else { tokens.push({ kind: "char", char }); index++; }
  }
  const literal = tokens.every((token) => token.kind === "char");
  return literal ? { name: tokens.map((token) => token.kind === "char" ? token.char : "").join("") } : { tokens };
}

const fits = (token: Token, char: string): boolean => {
  switch (token.kind) {
    case "char": return token.char === char;
    case "one": return true;
    case "class": return token.ranges.some(([from, to]) => from <= char && char <= to) !== token.negate;
    case "star": return false;
    default: { const unreachable: never = token; throw new Error(`unknown glob token ${JSON.stringify(unreachable)}`); }
  }
};

/** A leading dot is matched only by a literal dot, as glob(3) does. */
export function matchComponent(tokens: readonly Token[], name: string, budget: { steps: number }): boolean | null {
  const text = Array.from(name);
  const head = tokens[0];
  if (text[0] === "." && (head?.kind !== "char" || head.char !== ".")) return false;
  // what one `?` or bracket stands for in a name beyond ASCII (a byte, or a character) is ssh's locale's to say
  if (/[^\x00-\x7f]/.test(name) && tokens.some((token) => token.kind === "one" || token.kind === "class")) return null;
  let [at, from, star, starFrom] = [0, 0, -1, 0];
  while (from < text.length) {
    const token = tokens[at];
    budget.steps -= token?.kind === "class" ? Math.max(1, token.ranges.length) : 1;
    if (budget.steps < 0) return null;
    if (token?.kind === "star") { [star, starFrom] = [at++, from]; continue; }
    if (token !== undefined && fits(token, text[from]!)) { at++; from++; continue; }
    if (star < 0) return false;
    [at, from] = [star + 1, ++starFrom];
  }
  while (tokens[at]?.kind === "star") at++;
  return at === tokens.length;
}
