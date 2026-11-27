/**
 * Maps changed files or named surfaces to the CI browser regression scripts (`scripts/ci-browser.sh`)
 * that cover them, ordered by direct script imports, shared DOM/API/protocol tokens and surface.
 *
 *   bun scripts/browser-checks.ts                        # changed/untracked files vs origin/main
 *   bun scripts/browser-checks.ts <path-or-surface>...   # explicit files, folders or surface:<id>
 *   bun scripts/browser-checks.ts --surfaces             # print the feature surface map
 *   bun scripts/browser-checks.ts --run [...]            # run the matched CI browser scripts safely
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { demoOnlyScripts, serialBrowserScripts } from "./ci-browser-parallel.ts";

const REPO = resolve(import.meta.dir, "..");
const DEFAULT_LIMIT = 12;
const MAX_TOKEN_DOC_FREQ = 8;
const MAX_CALLER_FAN_IN = 6;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const INDEXED_SOURCE = /^(?:src|server|shared|site\/demo)\/.*\.(?:[cm]?[jt]sx?|css)$/;
const TEST_SOURCE = /\.(?:test|contract\.test)\.[cm]?[jt]sx?$/;
/** CI's own script filters, which would narrow or empty the set this tool picked, and a reused check directory, whose herdr sessions the runner stops. */
const CI_SELECTION = ["BROWSER_SHARD", "BROWSER_EXCLUDE", "BROWSER_LIVE_ONLY", "CHECK_DIR"];
const LIVE_HERDR = ["HERDR_SOCKET", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_CONFIG_PATH", "HERDR_TEST_LIVE"];

/** Shared script helpers that nearly every browser script loads; importing one does not tie a script to one feature. */
const SHARED_HARNESS_SCRIPTS = new Set([
  "scripts/browser-evidence.ts",
  "scripts/chrome-path.ts",
  "scripts/demo-build.ts",
  "scripts/demo-server.ts",
  "scripts/disposable-config.ts",
  "scripts/own-herdr.ts",
  "scripts/own-processes.ts",
  "scripts/settings-page.ts",
  "scripts/test-herdr.ts",
  "scripts/test-shell.ts",
]);

export interface BrowserSurface {
  readonly id: string;
  readonly summary: string;
  readonly sources: RegExp;
  readonly scripts: RegExp;
}

export const BROWSER_SURFACES: readonly BrowserSurface[] = [
  {
    id: "terminal",
    summary: "Attached and mirrored panes, libghostty rendering, selection, scrollback, fonts, pinch and mobile key bar",
    sources: /^(?:src\/components\/(?:Terminal|Mirror|KeyBar)|src\/lib\/(?:terminal|ghostty|keyBar|mirror|xterm)|server\/(?:pty\/|mirror\.ts|core\/terminal))/,
    scripts: /^scripts\/(?:ui-terminal|ui-ime|terminal-|mirror-|core-history-|core-kept-grid-|key-bar-|sticky-modifiers-|codex-drag-|pane-input-focus-|pane-paging-|application-paging-|replay-clipboard-)/,
  },
  {
    id: "chat",
    summary: "Agent conversation lens, streaming turns, working state, quotes, reply comments, math, search and session history",
    sources: /^(?:src\/components\/(?:Chat|Conversation|Turn|Reply|Markdown|Math|SessionHistory|SkillActivity|Background)|src\/lib\/(?:chat|conversation|markdown|sessionHistory|i18n\/chat)|server\/(?:conversation|transcript|agy|claude|codex|copilot|grok|omp|omo|session-history)|shared\/session-history)/,
    scripts: /^scripts\/(?:chat-|[a-z]+-chat-browser|[a-z-]+-image-browser-qa|gjc-status-|agy-chat-|copilot-chat-|conversation-search-|reply-comments-|math-browser-|session-history-|omo-plan-|plan-chip-|background-agent-|command-outcome-|todo-snapshots-)/,
  },
  {
    id: "composer",
    summary: "Message composer, drafts, attachments, dictation, slash skills and Send / Stop controls",
    sources: /^(?:src\/components\/(?:Composer|Voice|Attachment|Skill)|src\/lib\/(?:composer|draft|voice|i18n\/(?:composer|settings-composer))|server\/core\/composer|shared\/voice)/,
    scripts: /^scripts\/(?:composer-|restored-draft-|agent-skill-menu-|new-session-skills-)/,
  },
  {
    id: "pending",
    summary: "Queued and held messages, Send now steering, pending leases and unconfirmed input across disconnects",
    sources: /^(?:src\/components\/Held|server\/(?:pending-input\.ts|input-guard\.ts|codex-steering\.ts|core\/(?:pending|input|status)\.ts))/,
    scripts: /^scripts\/(?:pending-|held-rows-|unconfirmed-input-)/,
  },
  {
    id: "prompts",
    summary: "Interactive approval cards, question sheets, secret input and prompt answers",
    sources: /^(?:src\/components\/(?:Prompt|Approval|Question)|src\/lib\/prompt|server\/prompt)/,
    scripts: /^scripts\/(?:prompt-|opencode-prompt-|pi-questionnaire-|omo-question-|files-prompt-)/,
  },
  {
    id: "files",
    summary: "Files dialog and docked panel, Markdown/source/media viewer, in-app text editor and local web panel",
    sources: /^(?:src\/components\/(?:Files|FileViewer|DirectoryBrowser|TextFile|HighlightedCode|MarkdownOutline|BrowserPanel|BrowserSidePanel)|src\/lib\/(?:file|saveImage|sourcePreview|textPreview|highlight|i18n\/files)|server\/(?:fs|files)|shared\/files)/,
    scripts: /^scripts\/(?:files-|file-viewer-|file-preview-|markdown-outline-|built-in-browser-|file-text-size-|text-file-edit-|docked-file-link-|web-panel-|palette-local-page-|artifacts-browser-|virtual-source-)/,
  },
  {
    id: "diff",
    summary: "Repository status, diff viewer, inline diff line notes and find-in-diff",
    sources: /^(?:src\/components\/(?:RepoChanges|Diff)|src\/lib\/(?:diff|useRepoDiff)|server\/git)/,
    scripts: /^scripts\/(?:repo-diff-|diff-)/,
  },
  {
    id: "sidebar",
    summary: "PCs and Agents sidebar, split resize, hover peek, pins, locks, named/state groups, filter and workspace rows",
    sources: /^(?:src\/components\/(?:WorkspaceSidebar|AgentSidebar|Sidebar|AgentGroup|AgentMark|WorkspaceRow)|src\/lib\/(?:sidebar|agentGroups|i18n\/sidebar))/,
    scripts: /^scripts\/(?:sidebar-|workspace-rows-|workspace-touch-reorder-|agent-lock-|agent-groups-|agent-state-groups-|agent-helpers-fold-|hide-pc-|pc-load-)/,
  },
  {
    id: "inbox",
    summary: "Agent inbox mode on phone and desktop, inbox rail, filters and thread switching",
    sources: /^(?:src\/components\/Inbox|src\/lib\/inbox)/,
    scripts: /^scripts\/inbox-mode-/,
  },
  {
    id: "settings",
    summary: "Settings dialog pages, segmented controls, search, interface/chat fonts and synced preferences",
    sources: /^(?:src\/components\/(?:Settings|AgentsSettings|Font)|src\/lib\/(?:settings|preferencesSync|i18n\/settings))/,
    scripts: /^scripts\/(?:settings-|setup-row-|cliproxy-settings-|interface-font-|preferences-sync-|agent-entry-points-|agents-sign-in-|setup-dialog-)/,
  },
  {
    id: "palette",
    summary: "Command palette, keyboard shortcut recording and exact-modifier chords",
    sources: /^(?:src\/components\/(?:CommandPalette|Shortcut)|src\/lib\/(?:palette|shortcuts|i18n\/palette))/,
    scripts: /^scripts\/(?:shortcut-|settings-palette-search-|palette-)/,
  },
  {
    id: "relay",
    summary: "E2EE relay pairing, hosted shell, offline reasons, client version floor and relayed media",
    sources: /^(?:relay\/|src\/components\/Relay|src\/lib\/(?:relay|i18n\/relay)|server\/relay\/|shared\/relay)/,
    scripts: /^scripts\/(?:relay-|offline-typing-relay-|ui-access-|add-pc-more-relay-)/,
  },
  {
    id: "account",
    summary: "Account sign-in, signed PC/device list, join approvals and device security",
    sources: /^(?:src\/components\/(?:Account|AccessGate|Device)|src\/lib\/(?:account|i18n\/devices)|server\/(?:account\/|auth\.ts|devices\.ts|access\.ts)|shared\/account)/,
    scripts: /^scripts\/(?:account-|relay-account-|my-pcs-|device-security-|security-summary-|lan-exposure-notice-|ui-access-)/,
  },
  {
    id: "machines",
    summary: "Local and SSH remote PCs, machine event transport, workspaces and worktrees",
    sources: /^(?:src\/components\/(?:AddPc|Machine|NewWorkspace|Worktree)|src\/lib\/(?:machines|i18n\/(?:machines|workspace))|server\/(?:machines|workspace-routes|herdr\/|herdr-core\/)|shared\/machines)/,
    scripts: /^scripts\/(?:machine-|my-pcs-|recent-folders-|phone-worktree-|newtab-typeahead-|folder-filter-|herdr-restart-|herdr-profiles-)/,
  },
  {
    id: "alerts",
    summary: "Web Push notifications, Discord/Telegram alert webhooks, sound alerts and droplet notices",
    sources: /^(?:push-relay\/|src\/components\/(?:Alert|Push|Droplet)|src\/lib\/(?:push|alerts)|server\/(?:push|alerts))/,
    scripts: /^scripts\/(?:push-health-|alert-|droplet-|notification-startup-)/,
  },
  {
    id: "themes",
    summary: "Built-in themes, custom Base16/Ovis theme files, first-paint bootstrap and contrast gates",
    sources: /^(?:src\/styles\.css$|src\/theme-bootstrap\.ts$|src\/lib\/(?:themes|themeBoot)|scripts\/(?:generate-themes|herdr-theme))/,
    scripts: /^scripts\/(?:theme-|design-gate-)/,
  },
  {
    id: "updates",
    summary: "Release update notices, PWA install hints, service worker and usage quotas",
    sources: /^(?:src\/components\/(?:Update|Install|Usage)|src\/(?:pwa\.ts|sw\.ts)|src\/lib\/(?:i18n\/(?:updates|usage))|server\/(?:supervisor|updater|usage)|shared\/(?:update|usage))/,
    scripts: /^scripts\/(?:update-notice-|pwa-update-|install-state-|revision-bound-update-|install-hint-|usage-)/,
  },
  {
    id: "shell",
    summary: "App shell layout, split panes, tabs, mobile viewport/keyboard, sheets, Back navigation and Safari polyfills",
    sources: /^(?:index\.html$|src\/(?:App\.tsx|main\.tsx)|src\/components\/(?:AppCrash|Header|Pane|Split|Tab|Sheet)|src\/lib\/(?:sheet|viewport|externalLink))/,
    scripts: /^scripts\/(?:ui-regression|ui-contexts-|reconnect-header-|header-context-|drawer-modal-|phone-split-grid-|touch-long-press-|context-menu-|deep-link-|health-flap-|boot-loading-|render-crash-|old-safari-|keyboard-viewport-|mobile-viewport-|phone-safe-area-|phone-back-|phone-glass-header-|sheet-outside-tap-|narrow-pane-|tab-|pane-lifetime-|pane-mute-|header-lens-|link-menu-|external-link-|wake-lock-|tap-targets-)/,
  },
];

export type BrowserScriptKind = "demo" | "herdr";

export interface BrowserMatch {
  readonly script: string;
  readonly kind: BrowserScriptKind;
  readonly seconds: number | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly command: string;
}

export interface BrowserCheckPlan {
  readonly inputs: readonly string[];
  readonly surfaces: readonly string[];
  readonly totalMatched: number;
  readonly matches: readonly BrowserMatch[];
}

export interface SurfaceSummary {
  readonly id: string;
  readonly summary: string;
  readonly demoCount: number;
  readonly herdrCount: number;
  readonly sampleScripts: readonly string[];
}

const toPosix = (value: string): string => value.replaceAll("\\", "/");

function walkFiles(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkFiles(root, rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

const NOISE_TOKEN = /^(?:flex-|grid-|text-|font-|border-|rounded-|shadow-|cursor-|select-|pointer-|overflow-|whitespace-|transition-|duration-|opacity-|z-index|inline-|block-|hidden-|webkit-|moz-|aria-|http-|https-|content-|application-|utf-8|en-us|no-cache|max-age|no-store|same-origin|keep-alive|user-agent|x-request-id|client-id|request-id|workspace-id|session-id|pane-id|machine-id|server-id|created-at|updated-at)/;

/**
 * Specific selectors, data attributes, API subpaths and protocol/error codes in `text`.
 * Common layout words and generic headers are excluded, and `MAX_TOKEN_DOC_FREQ` drops anything broad.
 */
export function extractCouplingTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/(?:[.#]|data-)([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)) {
    const raw = match[0]!.startsWith("data-") ? match[0]! : match[1]!;
    if (raw.length >= 6 && !NOISE_TOKEN.test(raw)) tokens.add(`dom:${raw}`);
  }
  for (const match of text.matchAll(/\b([a-z][a-z0-9]+(?:-[a-z0-9]+){2,})\b/g)) {
    const raw = match[1]!;
    if (raw.length >= 8 && !NOISE_TOKEN.test(raw)) tokens.add(`dom:${raw}`);
  }
  for (const match of text.matchAll(/["'`](\/(?:api|fs|workspace|machines|relay)\/[a-z0-9/_-]+)["'`]/g)) {
    tokens.add(`route:${match[1]!}`);
  }
  for (const match of text.matchAll(/["']([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})["']/g)) {
    const raw = match[1]!;
    if (raw.length >= 8) tokens.add(`code:${raw}`);
  }
  return tokens;
}

function directRelativeImports(root: string, file: string, text: string): string[] {
  if (!CODE_FILE.test(file)) return [];
  let scanned: { path: string }[] = [];
  try {
    scanned = new Bun.Transpiler({ loader: /\.[jt]sx$/.test(file) ? "tsx" : "ts" }).scanImports(text);
  } catch {
    return [];
  }
  const resolved: string[] = [];
  for (const { path: raw } of scanned) {
    const clean = raw.replace(/[?#].*$/, "");
    if (!clean.startsWith(".")) continue;
    const base = resolve(root, posix.dirname(file), clean);
    const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base.replace(/\.js$/, ".ts")]
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (hit !== undefined) resolved.push(toPosix(relative(root, hit)));
  }
  return resolved;
}

function readTimings(root: string): Record<string, number> {
  const path = join(root, "scripts/ci-browser-timings.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
}

interface RepoIndex {
  readonly scripts: readonly string[];
  readonly demoSet: ReadonlySet<string>;
  readonly timings: Readonly<Record<string, number>>;
  readonly scriptFiles: ReadonlyMap<string, ReadonlySet<string>>;
  readonly scriptDirectTargets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly scriptTokens: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sourceTokens: ReadonlyMap<string, ReadonlySet<string>>;
  readonly tokenDocFreq: ReadonlyMap<string, number>;
  readonly importersOf: ReadonlyMap<string, readonly string[]>;
}

const indexCache = new Map<string, RepoIndex>();

function repoIndex(root: string): RepoIndex {
  const key = resolve(root);
  const cached = indexCache.get(key);
  if (cached !== undefined) return cached;
  const built = buildIndex(key);
  indexCache.set(key, built);
  return built;
}

function buildIndex(root: string): RepoIndex {
  const scripts = serialBrowserScripts(readFileSync(join(root, "scripts/ci-browser.sh"), "utf8"));
  const demoSet = new Set(demoOnlyScripts(scripts, root));
  const timings = readTimings(root);
  const textCache = new Map<string, string>();
  const importCache = new Map<string, string[]>();
  const readText = (rel: string): string => {
    const cached = textCache.get(rel);
    if (cached !== undefined) return cached;
    const content = readFileSync(join(root, rel), "utf8");
    textCache.set(rel, content);
    return content;
  };
  const importsIn = (rel: string): string[] => {
    const cached = importCache.get(rel);
    if (cached !== undefined) return cached;
    const list = directRelativeImports(root, rel, readText(rel));
    importCache.set(rel, list);
    return list;
  };

  const sources = ["src", "server", "shared", "site/demo"]
    .flatMap((dir) => walkFiles(root, dir))
    .filter((file) => INDEXED_SOURCE.test(file) && !TEST_SOURCE.test(file));

  const sourceTokens = new Map<string, Set<string>>();
  const tokenDocFreq = new Map<string, number>();
  const importersOf = new Map<string, string[]>();

  for (const file of sources) {
    const tokens = extractCouplingTokens(readText(file));
    sourceTokens.set(file, tokens);
    for (const token of tokens) tokenDocFreq.set(token, (tokenDocFreq.get(token) ?? 0) + 1);
    for (const dep of importsIn(file)) {
      const list = importersOf.get(dep) ?? [];
      list.push(file);
      importersOf.set(dep, list);
    }
  }

  const scriptFiles = new Map<string, ReadonlySet<string>>();
  const scriptDirectTargets = new Map<string, ReadonlySet<string>>();
  const scriptTokens = new Map<string, ReadonlySet<string>>();

  for (const script of scripts) {
    const ownScripts = new Set<string>([script]);
    const direct = new Set<string>();
    const pending = [script];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const text = readText(current);
      for (const dep of importsIn(current)) {
        if (!dep.startsWith("scripts/") || SHARED_HARNESS_SCRIPTS.has(dep)) {
          direct.add(dep);
        } else if (!ownScripts.has(dep)) {
          ownScripts.add(dep);
          pending.push(dep);
        }
      }
      for (const match of text.matchAll(/import\.meta\.dir,\s*["']([\w.-]+\.tsx?)["']/g)) {
        const child = `scripts/${match[1]!}`;
        if (SHARED_HARNESS_SCRIPTS.has(child)) direct.add(child);
        else if (!ownScripts.has(child) && existsSync(join(root, child))) {
          ownScripts.add(child);
          pending.push(child);
        }
      }
    }
    const tokens = new Set<string>();
    for (const own of ownScripts) {
      for (const token of extractCouplingTokens(readText(own))) tokens.add(token);
    }
    scriptFiles.set(script, ownScripts);
    scriptDirectTargets.set(script, direct);
    scriptTokens.set(script, tokens);
  }

  return { scripts, demoSet, timings, scriptFiles, scriptDirectTargets, scriptTokens, sourceTokens, tokenDocFreq, importersOf };
}

function commandFor(script: string, kind: BrowserScriptKind): string {
  return kind === "demo" ? `bun ${script}` : `bun run check run --build bun ${script}`;
}

export function summarizeSurfaces(root = REPO): SurfaceSummary[] {
  const { scripts, demoSet } = repoIndex(root);
  return BROWSER_SURFACES.map((surface) => {
    const matched = scripts.filter((script) => surface.scripts.test(script));
    const demoCount = matched.filter((script) => demoSet.has(script)).length;
    return {
      id: surface.id,
      summary: surface.summary,
      demoCount,
      herdrCount: matched.length - demoCount,
      sampleScripts: matched.slice(0, 3),
    };
  });
}

function normalizeTarget(root: string, raw: string): { kind: "surface"; id: string } | { kind: "paths"; paths: string[] } {
  if (raw.startsWith("surface:")) {
    const id = raw.slice("surface:".length).trim();
    if (!BROWSER_SURFACES.some((surface) => surface.id === id)) {
      throw new Error(`Unknown surface "${id}". Run \`bun scripts/browser-checks.ts --surfaces\` to list them.`);
    }
    return { kind: "surface", id };
  }
  const path = toPosix(raw);
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = toPosix(relative(root, abs)).replace(/\/+$/, "");
  if (rel === "" || rel.startsWith("..")) throw new Error(`Path must be inside the repository: ${raw}`);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return { kind: "paths", paths: walkFiles(root, rel) };
  }
  return { kind: "paths", paths: [rel] };
}

export function changedFiles(root = REPO, base?: string): string[] {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  let resolvedBase = base;
  if (!resolvedBase) {
    const mergeBase = git("merge-base", "HEAD", "origin/main");
    resolvedBase = mergeBase.status === 0 ? mergeBase.stdout.trim() : "HEAD";
  }
  const tracked = git("diff", "--name-only", "--no-renames", resolvedBase, "--");
  if (tracked.status !== 0) throw new Error(`git diff --name-only ${resolvedBase} failed: ${tracked.stderr.trim()}`);
  const staged = git("diff", "--name-only", "--no-renames", "--cached");
  const unstaged = git("diff", "--name-only");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  const all = new Set<string>();
  for (const out of [tracked.stdout, staged.stdout, unstaged.stdout, untracked.stdout]) {
    for (const line of out.split("\n").map((entry) => entry.trim()).filter(Boolean)) all.add(toPosix(line));
  }
  return [...all].sort();
}

export function findBrowserChecks(targets: readonly string[], options: { root?: string; limit?: number } = {}): BrowserCheckPlan {
  const root = options.root ?? REPO;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const index = repoIndex(root);

  const requestedSurfaces = new Set<string>();
  const rawPaths = new Set<string>();
  for (const target of targets) {
    const normalized = normalizeTarget(root, target);
    if (normalized.kind === "surface") requestedSurfaces.add(normalized.id);
    else for (const path of normalized.paths) rawPaths.add(path);
  }

  // Strip .test.ts/.test.tsx siblings into the implementation file they sit beside when it exists,
  // so editing Foo.test.tsx also finds Foo.tsx's browser checks.
  const effectivePaths = new Set<string>();
  for (const path of rawPaths) {
    effectivePaths.add(path);
    if (TEST_SOURCE.test(path) && !path.startsWith("scripts/")) {
      const stem = path.replace(/\.(?:contract\.)?test(?=\.[cm]?[jt]sx?$)/, "").replace(/\.[a-zA-Z0-9_-]+(?=\.[cm]?[jt]sx?$)/, "");
      for (const candidate of [path.replace(/\.(?:contract\.)?test(\.[cm]?[jt]sx?)$/, "$1"), stem]) {
        if (existsSync(join(root, candidate))) effectivePaths.add(candidate);
      }
    }
  }

  const matchedSurfaces = new Set<string>(requestedSurfaces);
  for (const path of effectivePaths) {
    for (const surface of BROWSER_SURFACES) {
      if (surface.sources.test(path) || surface.scripts.test(path)) matchedSurfaces.add(surface.id);
    }
  }

  // A change strictly inside server/ cannot reach demo-only browser scripts (ci-browser-parallel.ts).
  const serverOnly = requestedSurfaces.size === 0
    && effectivePaths.size > 0
    && [...effectivePaths].every((path) => path.startsWith("server/"));

  // Collect rare tokens for the changed files, plus 1-hop importer/CSS companions in src/.
  const targetTokenWeights = new Map<string, number>();
  const addTokensFrom = (file: string, multiplier: number): void => {
    const tokens = index.sourceTokens.get(file);
    if (!tokens) return;
    for (const token of tokens) {
      const df = index.tokenDocFreq.get(token) ?? 99;
      if (df > MAX_TOKEN_DOC_FREQ) continue;
      const weight = (16 / df) * multiplier;
      const prev = targetTokenWeights.get(token) ?? 0;
      if (weight > prev) targetTokenWeights.set(token, weight);
    }
  };

  const oneHopTargets = new Set<string>();
  for (const path of effectivePaths) {
    addTokensFrom(path, 1);
    if (path.endsWith(".css")) {
      const tsx = path.replace(/\.css$/, ".tsx");
      if (index.sourceTokens.has(tsx)) {
        addTokensFrom(tsx, 0.85);
        oneHopTargets.add(tsx);
      }
    }
    const importers = index.importersOf.get(path) ?? [];
    if (importers.length > 0 && importers.length <= MAX_CALLER_FAN_IN) {
      for (const importer of importers) {
        oneHopTargets.add(importer);
        addTokensFrom(importer, 0.25);
      }
    }
  }

  const scored: BrowserMatch[] = [];
  for (const script of index.scripts) {
    const isDemo = index.demoSet.has(script);
    if (serverOnly && isDemo) continue;
    const kind: BrowserScriptKind = isDemo ? "demo" : "herdr";
    const reach = index.scriptFiles.get(script)!;
    const direct = index.scriptDirectTargets.get(script)!;
    const sTokens = index.scriptTokens.get(script)!;

    let score = 0;
    const reasons: string[] = [];

    for (const path of effectivePaths) {
      if (path === script || (path.startsWith("scripts/") && !SHARED_HARNESS_SCRIPTS.has(path) && reach.has(path))) {
        score += 100;
        reasons.push(path === script ? "edited script" : `loads ${path}`);
      } else if (direct.has(path)) {
        score += 45;
        reasons.push(`imports ${path}`);
      }
    }
    for (const hop of oneHopTargets) {
      if (direct.has(hop) && !effectivePaths.has(hop)) {
        score += 20;
        reasons.push(`imports ${hop}`);
      }
    }

    const tokenHits: { token: string; weight: number }[] = [];
    for (const [token, weight] of targetTokenWeights) {
      if (sTokens.has(token)) tokenHits.push({ token, weight });
    }
    if (tokenHits.length > 0) {
      tokenHits.sort((a, b) => b.weight - a.weight);
      const tokenScore = Math.min(60, tokenHits.reduce((sum, hit) => sum + hit.weight, 0));
      score += tokenScore;
      const labels = tokenHits.slice(0, 3).map(({ token }) => token.replace(/^dom:/, ".").replace(/^(?:route|code):/, ""));
      reasons.push(`tokens ${labels.join(", ")}`);
    }

    const scriptSurfaces = BROWSER_SURFACES.filter((surface) => matchedSurfaces.has(surface.id) && surface.scripts.test(script));
    if (scriptSurfaces.length > 0) {
      const explicit = scriptSurfaces.some((surface) => requestedSurfaces.has(surface.id));
      score += explicit ? 25 : 20;
      reasons.push(`surface ${scriptSurfaces.map((surface) => surface.id).join(", ")}`);
    }

    if (score <= 0) continue;
    const rawSeconds = index.timings[script];
    const seconds = Number.isFinite(rawSeconds) ? rawSeconds! : null;
    scored.push({
      script,
      kind,
      seconds,
      score: Math.round(score * 10) / 10,
      reasons,
      command: commandFor(script, kind),
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.seconds ?? 999) - (b.seconds ?? 999) || a.script.localeCompare(b.script));
  const matches = limit > 0 ? scored.slice(0, limit) : scored;

  return {
    inputs: [...targets],
    surfaces: [...matchedSurfaces].sort(),
    totalMatched: scored.length,
    matches,
  };
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !LIVE_HERDR.includes(key) && !CI_SELECTION.includes(key)) env[key] = value;
  }
  return Object.assign(env, extra);
}

/** Scripts that open the desktop shell need `bun run build:shell` first; the check runner builds only dist/. */
const needsShellBuild = (scripts: readonly string[], root: string): boolean =>
  scripts.some((script) => readFileSync(join(root, script), "utf8").includes("dist-shell"));

function runMatched(matches: readonly BrowserMatch[], root = REPO): number {
  if (matches.length === 0) {
    console.log("No matching CI browser scripts to run.");
    return 0;
  }
  const scripts = matches.map((match) => match.script);
  const needsHerdr = matches.some((match) => match.kind === "herdr");
  if (needsShellBuild(scripts, root)) {
    const shell = spawnSync(process.execPath, ["run", "build:shell"], { cwd: root, env: cleanEnv({}), stdio: "inherit" });
    if (shell.status !== 0) return shell.status ?? 1;
  }

  const args = needsHerdr
    ? ["scripts/check.ts", "run", "--build", "--", process.execPath, "scripts/ci-browser-parallel.ts"]
    : ["scripts/ci-browser-parallel.ts"];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: cleanEnv({
      BROWSER_SCRIPTS: scripts.join(","),
      BROWSER_WORKERS: matches.every((match) => match.kind === "demo") ? "2" : "1",
    }),
    stdio: "inherit",
  });
  return result.status ?? 1;
}

const USAGE = `Usage:
  bun scripts/browser-checks.ts [--base <rev>] [--limit <n>] [--json] [--run] [<path-or-surface>...]
  bun scripts/browser-checks.ts --surfaces [--json]

Examples:
  bun scripts/browser-checks.ts                                  # match changed files vs origin/main
  bun scripts/browser-checks.ts src/components/FileViewer.tsx    # match explicit file(s)
  bun scripts/browser-checks.ts --surface files --limit 5        # list top scripts in a surface
  bun scripts/browser-checks.ts --run src/lib/sidebarPeek.ts     # run matched scripts in isolation`;

export function runCli(argv: readonly string[], root = REPO): number {
  let base: string | undefined;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let run = false;
  let listSurfaces = false;
  const targets: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (arg === "--surfaces") { listSurfaces = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--run") { run = true; continue; }
    if (arg === "--base") {
      const next = argv[++i];
      if (!next) throw new Error("--base requires a git revision");
      base = next;
      continue;
    }
    if (arg === "--limit") {
      const next = argv[++i];
      const parsed = Number(next);
      if (!next || !Number.isInteger(parsed) || parsed < 0) throw new Error(`--limit requires a non-negative integer, got "${next ?? ""}"`);
      limit = parsed;
      continue;
    }
    if (arg === "--surface") {
      const next = argv[++i];
      if (!next) throw new Error("--surface requires a surface id");
      targets.push(`surface:${next}`);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
    targets.push(arg);
  }

  if (listSurfaces) {
    const summaries = summarizeSurfaces(root);
    if (json) {
      console.log(JSON.stringify(summaries, null, 2));
      return 0;
    }
    console.log(`${"surface".padEnd(12)}${"demo".padStart(6)}${"herdr".padStart(7)}  summary`);
    for (const s of summaries) {
      console.log(`${s.id.padEnd(12)}${String(s.demoCount).padStart(6)}${String(s.herdrCount).padStart(7)}  ${s.summary}`);
    }
    return 0;
  }

  const resolvedTargets = targets.length > 0 ? targets : changedFiles(root, base);
  if (resolvedTargets.length === 0) {
    if (json) console.log(JSON.stringify({ inputs: [], surfaces: [], totalMatched: 0, matches: [] }, null, 2));
    else console.log("No changed files found. Pass explicit paths or `--surface <id>`, or `--surfaces` to browse.");
    return 0;
  }

  const plan = findBrowserChecks(resolvedTargets, { root, limit });
  if (json && !run) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  console.log(`Inputs (${plan.inputs.length}): ${plan.inputs.slice(0, 6).join(", ")}${plan.inputs.length > 6 ? ` (+${plan.inputs.length - 6} more)` : ""}`);
  if (plan.surfaces.length > 0) console.log(`Surfaces: ${plan.surfaces.join(", ")}`);
  if (plan.matches.length === 0) {
    console.log("Matched CI browser scripts: none");
    return 0;
  }
  const truncated = plan.totalMatched > plan.matches.length ? ` (showing top ${plan.matches.length} of ${plan.totalMatched}; --limit 0 shows all)` : "";
  console.log(`Matched CI browser scripts: ${plan.totalMatched}${truncated}\n`);
  for (const match of plan.matches) {
    const secs = match.seconds === null ? "  ?s" : `${String(match.seconds).padStart(3)}s`;
    console.log(`  [${match.kind.padEnd(5)} ${secs}] ${match.script}  (${match.reasons.join("; ")})`);
  }
  if (!run) {
    const allDemo = plan.matches.every((match) => match.kind === "demo");
    const list = plan.matches.map((match) => match.script).join(",");
    const quick = plan.matches.length === 1
      ? plan.matches[0]!.command
      : allDemo
        ? `BROWSER_SCRIPTS=${list} bun scripts/ci-browser-parallel.ts`
        : `BROWSER_SCRIPTS=${list} bun run check run --build -- bun scripts/ci-browser-parallel.ts`;
    const shell = needsShellBuild(plan.matches.map((match) => match.script), root) ? "bun run build:shell && " : "";
    console.log(`\nRun ${plan.matches.length === 1 ? "it" : "these"} (or pass --run):\n  ${shell}${quick}`);
    return 0;
  }
  console.log("");
  return runMatched(plan.matches, root);
}

if (import.meta.main) {
  try {
    process.exit(runCli(process.argv.slice(2)));
  } catch (error) {
    console.error(`browser-checks: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
