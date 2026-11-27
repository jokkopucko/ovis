/** The existing direct Codex executable/script rule, shared with verified nested terminals. */
/** Interpreter options that run code or load a module: whatever follows is not the script. */
const CODE_OPTIONS = new Set(["eval", "print", "require", "import", "loader", "experimental-loader", "input-type"]);
/** Interpreter and shell options that take no value, so the script may follow them directly. */
const VALUELESS_OPTIONS = new Set([
  "", "no-warnings", "no-deprecation", "trace-warnings", "trace-deprecation", "pending-deprecation", "throw-deprecation",
  "enable-source-maps", "preserve-symlinks", "preserve-symlinks-main", "expose-gc", "abort-on-uncaught-exception",
  "experimental-strip-types", "experimental-transform-types", "experimental-vm-modules", "experimental-require-module",
  "no-experimental-fetch", "harmony", "bun", "smol", "hot", "watch", "noprofile", "norc", "posix", "login",
]);

export function isCodexInterpreter(executable: string): boolean {
  return /(?:^|[\\/])(?:node|bun|sh|bash|dash|zsh)(?:\.exe)?$/.test(executable);
}

const CODEX_EXECUTABLE = /(?:^|[\\/])codex(?:-(?:x86_64|aarch64)-[a-z0-9_-]+)?(?:\.js|\.exe|\.opencodex-real)?$/i;

export function isCodexExecutable(argv: readonly string[]): boolean {
  const executable = argv[0] ?? "";
  // also a release binary named for its target, and any letter case of Windows' file names
  if (CODEX_EXECUTABLE.test(executable)) return true;
  // `node codex.js` and shell shebangs name the script after the interpreter and its
  // `--flag` options (`node --no-warnings codex.js`). Only options known to take no
  // value may precede the script, plus `--name=value` forms that do not run code: an
  // option that takes the next argument (`--title x`, `-e`, `-c`) or one that evaluates
  // code or loads a module ends the search, since what follows it is not the script.
  // Later arguments (echo, etc.) are not executables.
  if (!isCodexInterpreter(executable)) return false;
  let script = 1;
  for (; argv[script]?.startsWith("--"); script++) {
    const option = argv[script] ?? "";
    const name = option.slice(2, option.includes("=") ? option.indexOf("=") : undefined);
    if (CODE_OPTIONS.has(name)) return false;
    if (!option.includes("=") && !VALUELESS_OPTIONS.has(name)) return false;
  }
  return CODEX_EXECUTABLE.test(argv[script] ?? "");
}

/** The value of a long option, before the end-of-options marker. */
export function optionValue(argv: readonly string[], name: string): string | null {
  for (const [index, arg] of argv.entries()) {
    if (arg === "--") return null;
    if (arg === name) return argv[index + 1] ?? null;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

export function codexAppServerSocket(argv: readonly string[]): string | null {
  const options = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : undefined);
  return CODEX_EXECUTABLE.test(argv[0] ?? "") && options.includes("app-server") ? optionValue(argv, "--listen") : null;
}

export type CodexConversationMode = "local" | "remote" | "rejected" | "unavailable";

/** Readable contradictions are never weakened into an unknown local-history fallback. */
export function codexConversationMode(argv: readonly string[] | null | undefined): CodexConversationMode {
  if (!argv?.length) return "unavailable";
  if (!isCodexExecutable(argv)) return "rejected";
  const end = argv.indexOf("--");
  if (argv.some((word, index) => (end < 0 || index < end) && (word === "--remote" || word.startsWith("--remote=")))) return "remote";
  return "local";
}
