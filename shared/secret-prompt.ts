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

/**
 * The line a program prints before it reads a secret, up to its colon, as each of these writes it. An ssh server
 * that asks interactively (a Mac, PAM) and doas put `(user@host) ` before theirs. A colon of either width ends a
 * prompt: sudo's in Chinese is full-width.
 */
const SECRET_PROMPT = new RegExp(`^(?:(?:doas )?\\([^\\s()]+@[^\\s()]+\\) )?(?:${[
  // sudo names the user in the session's language (`[sudo] alice의 암호:`), so anything it asks after `[sudo] `;
  // sudo-rs asks `[sudo: authenticate] Password:`, and what it asks in the clear is `[sudo: input needed] …`
  /\[sudo(?:: authenticate)?\] [^:：]+/,
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
  // passwd
  /(?:current|new|retype new) password/,
  // mysql and mariadb; restic and pass say what the password is for
  /enter password(?: for [^:]+)?/,
  // gpg's pinentry on a terminal
  /passphrase/,
  // openssl, which asks again for a new key
  /(?:verifying - )?enter (?:pem )?pass phrase(?: for [^:]+)?/,
].map((prompt) => prompt.source).join("|")})[:：]$`, "i");

// a yes/no choice is no secret: `y/n` in brackets, or after a space or a mark and before anything that does not
// go on as a name (` y/n:`, `,y/n:`, `-y/n:`, ` y/n/a:`, `'y/n'`). Not inside a name: the letters around a path's
// slash (`/home/andy/notes/key`), two of its folders (`/home/y/n/key`), a repository (`team-y/n-tools.git`), a
// path that goes on (`team-y/n/repo.git`: more than one letter after the next slash is no third option), or the
// start of a wrapped row, which is tested before the rows above it are joined (`…/compan` then `y/n-prod:`)
const ASKS_CHOICE = /\?|[([]\s*y\s*\/\s*n|[^a-z0-9/]y\s*\/\s*n(?![a-z0-9_.-]|\/[a-z0-9_.-]{2})/i;

/** Whose reading of a prompt: 3 this one's, 2 a server's that lists `secret-prompts-2` and no more, 1 any server's before that. */
export type PromptSet = 1 | 2 | 3;

// The prompts and the yes/no test of servers already released, each as it shipped and not to be changed. Such a
// server answers `invalid_secret` to a `secret` at a prompt its own copy does not read, so a page sends it one only
// for a prompt of its set, and types what it reads beyond that (ws.ts sendSecret).
const SHIPPED: Record<1 | 2, { prompt: RegExp; choice: RegExp }> = {
  // every server with `secret-input`
  1: {
    prompt: /^(?:\[sudo\] password for [^:]+|[^\s@]+@[^\s:]+['’]s password|password(?: for [^:]+)?|enter passphrase(?: for key ['’][^\r\n]+['’])?|enter pin(?: for [^:]+)?|(?:repeat|verify|confirm) password):$/i,
    choice: /\?|y\s*\/\s*n/i,
  },
  // one that lists `secret-prompts-2` (#3566, in 0.5.3's betas): git over HTTPS, ssh-add, ssh-keygen, an IPv6 host
  2: {
    prompt: new RegExp(`^(?:${[
      /\[sudo\] password for [^:]+/,
      /[^\s@]+@\S+['’]s password/,
      /password(?: for (?:['’][^'’\r\n]+['’]|[^:]+))?/,
      /enter passphrase(?: for [^\r\n]+)?/,
      /bad passphrase, try again for [^\r\n]+/,
      /enter (?:old |new |same )?passphrase(?: again)?(?: \(empty for no passphrase\))?/,
      /enter pin(?: for [^:]+)?/,
      /(?:repeat|verify|confirm) password/,
    ].map((prompt) => prompt.source).join("|")}):$`, "i"),
    choice: /\?|[([]\s*y\s*\/\s*n|[^a-z0-9/]y\s*\/\s*n(?=\s|:|$)/i,
  },
};

/**
 * Deliberately narrow: prose mentioning passwords must not become an input prompt. `set`: as a server already
 * released reads it (SHIPPED), for what a page may send that server.
 */
export function secretPrompt(screen: string, columns = Infinity, set: PromptSet = 3): string | null {
  const { prompt: asks, choice } = set === 3 ? { prompt: SECRET_PROMPT, choice: ASKS_CHOICE } : SHIPPED[set];
  const lines = screen.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  let line = lines.pop()?.trimEnd() ?? "";
  for (;;) {
    const candidate = line.trimStart();
    if (!candidate || candidate.length > 120 || choice.test(candidate)) return null;
    if (asks.test(candidate)) return candidate;
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

/** The first set that reads `prompt` as a prompt: what a server must read for a `secret` sent at it to be taken. */
export function promptSet(prompt: string): PromptSet {
  return secretPrompt(prompt, Infinity, 1) === prompt ? 1 : secretPrompt(prompt, Infinity, 2) === prompt ? 2 : 3;
}

/**
 * Whether the cursor is on the last line of the screen that holds text, which is where a prompt asks. `lines` are
 * the screen's lines, a wrapped row joined to the line above it, and `starts` each line's first screen row. A
 * program that has read its answer prints a line break and works on (git signing in, ssh-add reading its key,
 * sudo running a quiet command) with its prompt still the last text: it asks no more then, and an answer sent
 * again would wait in the terminal for whatever reads next, a shell for instance.
 *
 * Nearly every prompt ends in a space after its colon. When the colon fills the row's last column that space
 * wraps, and the cursor is past it on the next row. herdr's attach stream draws each row at its own place, so the
 * page has no wrapped row to join there: the space's row is a line of its own, blank. That is still the prompt
 * asking: the cursor on the row right below, past its start (`cursorX`), on a blank row, under a prompt whose last
 * row reaches the right edge (`columns`). After an answer the line break leaves the cursor at a row's start.
 * herdr writes every cell of a row, so the page's lines are all as wide as the pane: the prompt's row is measured
 * without its trailing spaces, to the edge or one column short of it (a colon there with its space in the last
 * column, or a wide character that did not fit: secretPrompt joins rows by the same measure).
 */
export function promptHasCursor(lines: readonly string[], starts: readonly number[], cursorRow: number, cursorX: number, columns: number): boolean {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  if (last < 0) return false;
  const below = last + 1 < starts.length ? starts[last + 1]! : Infinity;
  if (cursorRow >= starts[last]! && cursorRow < below) return true;
  return cursorRow === below && cursorX > 0 && displayWidth(lines[last]!.trimEnd()) >= columns - 1;
}

/**
 * Whether a prompt on the screen still asks, for a pane whose cursor is known. `onLine`: promptHasCursor. `seen` is
 * the prompt last seen with the cursor on it, which the caller keeps and passes back. A prompt whose cursor was on
 * its line and has left was answered: the program printed its line break. One whose cursor was never seen on it asks
 * for as long as it is the last text: a script that prints the prompt and a line break and reads below it
 * (`echo "Password:"; read -s`), or a screen first seen after the answer, which reads as it always did.
 */
export function promptAsks(prompt: string | null, onLine: boolean, seen: string | null): { asks: boolean; seen: string | null } {
  if (prompt === null) return { asks: false, seen: null };
  if (onLine) return { asks: true, seen: prompt };
  return { asks: seen !== prompt, seen };
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
