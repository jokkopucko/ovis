/** Deliberately narrow: prose mentioning passwords must not become an input prompt. */
export function secretPrompt(screen: string, columns = Infinity): string | null {
  const lines = screen.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  let line = lines.pop()?.trimEnd() ?? "";
  for (;;) {
    const candidate = line.trimStart();
    if (!candidate || candidate.length > 120 || /\?|y\s*\/\s*n/i.test(candidate)) return null;
    if (/^(?:\[sudo\] password for [^:]+|[^\s@]+@[^\s:]+['’]s password|password(?: for [^:]+)?|enter passphrase(?: for key ['’][^\r\n]+['’])?|enter pin(?: for [^:]+)?|(?:repeat|verify|confirm) password):$/i.test(candidate)) return candidate;
    // herdr's screen-diff stream does not preserve xterm's soft-wrap flags. Only
    // continue a row that reached the right edge (a final space can be trimmed).
    const previous = lines.pop()?.trimEnd();
    if (!previous || previous.length < columns - 1 || previous.length > columns) return null;
    line = (previous.padEnd(columns) + line).trimStart();
  }
}

// a vendor's key prefix (OpenAI, Anthropic, DeepSeek and Stripe's sk-, GitHub, GitLab, Slack,
// Hugging Face, Groq, Replicate, xAI, npm, PyPI, Google, AWS), matched a few characters in so a key
// being typed is caught early; a JWT; a private key block
const KEY_SHAPES = [
  /(?:^|[^A-Za-z0-9])(?:sk|rk)[-_][A-Za-z0-9_-]{4,}/,
  /(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_|glpat-|xox[abposr]-|hf_|gsk_|r8_|xai-|npm_|pypi-)[A-Za-z0-9_-]{4,}/,
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{4,}/,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{4,}/,
  /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Whether text holds what looks like an API key or token (#2523): a vendor's shape, or a long run
 * mixing upper and lower case letters (and `_`) with digits, or 40 characters long without them. A `/` is
 * taken as part of a key only in a run of exactly 40 (an AWS secret key's length): anything else
 * with one is a path or a URL. A run holding a word (eight lower case letters in a row) is a name,
 * and hex alone is no key: commit hashes and image digests are kept as typed.
 */
export function looksLikeKey(text: string): boolean {
  if (KEY_SHAPES.some((shape) => shape.test(text))) return true;
  return (text.match(/[A-Za-z0-9/+_]{24,}/g) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && !/[a-z]{8}/.test(run)
    && (!run.includes("/") || run.length === 40) && (/\d/.test(run) || run.length >= 40));
}

/** A secret is one line of literal keystrokes; never allow terminal controls. */
export function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
