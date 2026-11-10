// A character cluster holding an East Asian Wide or Fullwidth character (Hangul, CJK, kana,
// fullwidth forms) or an emoji shown as emoji takes two terminal columns; one of only combining
// marks and zero-width characters takes none.
const WIDE = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}\p{Emoji_Presentation}]/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\u200b-\u200f\ufe00-\ufe0f]+$/u;
let graphemes: Intl.Segmenter | undefined;

/** Terminal columns a row of text fills: per grapheme, or per code point without Intl.Segmenter (Safari 14). */
export function displayWidth(text: string): number {
  if (typeof Intl.Segmenter === "function") graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const clusters = graphemes ? Array.from(graphemes.segment(text), ({ segment }) => segment) : Array.from(text);
  let width = 0;
  for (const cluster of clusters) width += ZERO_WIDTH.test(cluster) ? 0 : WIDE.test(cluster) ? 2 : 1;
  return width;
}

/** The line a program prints before it reads a secret, up to its colon, as each of these writes it. */
const SECRET_PROMPT = new RegExp(`^(?:${[
  // sudo
  /\[sudo\] password for [^:]+/,
  // ssh: user@host, and an IPv6 host is written with colons
  /[^\s@]+@\S+['’]s password/,
  // su and login; git over HTTPS names the remote in quotes, its scheme's and port's colons and all
  /password(?: for (?:['’][^'’\r\n]+['’]|[^:]+))?/,
  // ssh names its key in quotes, ssh-keygen in double quotes, ssh-add as it is: a path or the key's comment, which
  // may hold colons (`/keys/id:work`, `C:\Users\…`), so the prompt ends at the line's last one. ssh-add asks again
  /enter passphrase(?: for [^\r\n]+)?/,
  /bad passphrase, try again for [^\r\n]+/,
  // ssh-keygen's other asks: a new key's passphrase and its repeat, and -p's old and new one
  /enter (?:old |new |same )?passphrase(?: again)?(?: \(empty for no passphrase\))?/,
  /enter pin(?: for [^:]+)?/,
  /(?:repeat|verify|confirm) password/,
].map((prompt) => prompt.source).join("|")}):$`, "i");

// a yes/no choice is no secret: `y/n` in brackets, with more options or not (`[Y/n]`, `(y/n/q)`), or as the last
// thing before a space, the colon or the line's end, after a space or a mark (` y/n:`, `,y/n:`, `-y/n:`). Not inside
// a name: the letters around a path's slash (`/home/andy/notes/key`), two of its folders (`/home/y/n/key`), a
// repository (`team-y/n-tools.git`), or the start of a wrapped row, which is tested before the rows above it are
// joined (`…/compan` then `y/n-prod:`)
const ASKS_CHOICE = /\?|[([]\s*y\s*\/\s*n|[^a-z0-9/]y\s*\/\s*n(?=\s|:|$)/i;

// Both as a server without the `secret-prompts-2` feature has them: it answers `invalid_secret` to a
// masked input for any other prompt, so a page sends such a server one only for these (ws.ts sendSecret).
const EARLIER_PROMPT = /^(?:\[sudo\] password for [^:]+|[^\s@]+@[^\s:]+['’]s password|password(?: for [^:]+)?|enter passphrase(?: for key ['’][^\r\n]+['’])?|enter pin(?: for [^:]+)?|(?:repeat|verify|confirm) password):$/i;
const EARLIER_CHOICE = /\?|y\s*\/\s*n/i;

/**
 * Deliberately narrow: prose mentioning passwords must not become an input prompt. `earlier`: only
 * the prompts a server without `secret-prompts-2` takes too, each of them a prompt without it as well.
 */
export function secretPrompt(screen: string, columns = Infinity, earlier = false): string | null {
  const lines = screen.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  let line = lines.pop()?.trimEnd() ?? "";
  for (;;) {
    const candidate = line.trimStart();
    if (!candidate || candidate.length > 120 || (earlier ? EARLIER_CHOICE : ASKS_CHOICE).test(candidate)) return null;
    if ((earlier ? EARLIER_PROMPT : SECRET_PROMPT).test(candidate)) return candidate;
    // herdr's screen-diff stream does not preserve xterm's soft-wrap flags. Only
    // continue a row that reached the right edge (a final space can be trimmed).
    const previous = lines.pop()?.trimEnd();
    // Rows are measured in columns, as the terminal fills them.
    const width = previous ? displayWidth(previous) : 0;
    if (!previous || width < columns - 1 || width > columns) return null;
    // Pad to the edge as xterm reads a wrapped row (an empty last cell, as a wide character that
    // did not fit leaves, reads as a space), so the browser and the server agree on the prompt. No
    // trim of the joined text: a wrapped row's leading space is part of the prompt (the candidate
    // is trimmed).
    line = previous + " ".repeat(columns - width) + line;
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

// where no passphrase is an answer: ssh-keygen says so when it asks for a new one, and asks for the same again
const TAKES_NONE = /\(empty for no passphrase\):$|^enter same passphrase again:$/i;

/**
 * A secret is one line of literal keystrokes; never allow terminal controls. An empty one is an answer only to a
 * `prompt` that takes none (Enter alone): anywhere else it is a field sent by mistake.
 */
export function validSecret(value: unknown, prompt?: string): value is string {
  return typeof value === "string" && (value.length > 0 || (prompt !== undefined && TAKES_NONE.test(prompt)))
    && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
