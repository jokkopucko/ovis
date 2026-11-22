/**
 * ssh's host patterns (`*` any run, `?` one character) for the ssh config reader (server/ssh-config.ts), at a cost
 * bounded by the pattern and the text: a match that would take more is left unknown (null), never guessed.
 */

const MIN_STEPS = 10_000;
const STEPS_PER_CHAR = 4;

const fitsAt = (part: string, text: string, at: number): boolean => {
  for (let index = 0; index < part.length; index++) if (part[index] !== "?" && part[index] !== text[at + index]) return false;
  return true;
};

function findPart(part: string, text: string, from: number, end: number, budget: { steps: number }): number | null {
  if (part.includes("?")) {
    for (let at = from; at + part.length <= end; at++) {
      let index = 0;
      for (; index < part.length; index++) {
        if (--budget.steps < 0) return null;
        const wanted = part.charCodeAt(index);
        if (wanted !== 63 && wanted !== text.charCodeAt(at + index)) break;
      }
      if (index === part.length) return at;
    }
    return -1;
  }
  if (part === "") return from;
  const fallback = new Int32Array(part.length);
  for (let index = 1, length = 0; index < part.length; index++) {
    while (length > 0 && part[index] !== part[length]) length = fallback[length - 1]!;
    if (part[index] === part[length]) length++;
    fallback[index] = length;
  }
  for (let at = from, length = 0; at < end; at++) {
    while (length > 0 && text[at] !== part[length]) length = fallback[length - 1]!;
    if (text[at] === part[length]) length++;
    if (length === part.length) return at - length + 1;
  }
  return -1;
}

/**
 * Whether `text` matches an ssh pattern, compared as given: callers lowercase what ssh compares in lowercase. The ends
 * are checked in place and each part between stars is taken at its first place, which is never worse, so `*aaa…ab`
 * against a long alias costs one pass instead of one per start. Null when a part holding a `?` would take more steps
 * than the pattern and text are long.
 */
export function globMatch(glob: string, text: string): boolean | null {
  const parts = glob.split("*");
  if (parts.length === 1) return glob.length === text.length && fitsAt(glob, text, 0);
  const [first, last] = [parts[0]!, parts.at(-1)!];
  const end = text.length - last.length;
  if (first.length > end || !fitsAt(first, text, 0) || !fitsAt(last, text, end)) return false;
  const budget = { steps: MIN_STEPS + STEPS_PER_CHAR * (glob.length + text.length) };
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = findPart(part, text, at, end, budget);
    if (found === null || found < 0) return found === null ? null : false;
    at = found + part.length;
  }
  return true;
}

/**
 * ssh's pattern list (`a,b,!c`): a negated pattern that matches says no, else one other pattern matching says yes;
 * null when a pattern that could change the answer is unknown
 */
export function listMatches(patterns: readonly string[], text: string): boolean | null {
  const negated = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => globMatch(pattern.slice(1), text));
  if (negated.includes(true)) return false;
  const named = patterns.filter((pattern) => !pattern.startsWith("!")).map((pattern) => globMatch(pattern, text));
  const verdict = named.includes(true) ? true : named.includes(null) ? null : false;
  return verdict !== false && negated.includes(null) ? null : verdict;
}
