/**
 * The agents Ovis can install for a user: every supported coding agent and the always-on
 * assistants, each with the vendor's own install command per platform, copied from the vendor's
 * current docs (`sources`, with the date they were read), what the command needs on the PC, how to
 * tell it is installed, and how it is signed in to afterwards.
 *
 * Only a vendor's own command is listed: its own installer script on its own HTTPS address
 * (`url_prefixes`), or its own package (`packages`). shared/agent-catalog.test.ts holds every
 * command to both lists; a command that fetches anything else, or a package of another name,
 * fails it. A platform without an official command has none, and `no_install` says why.
 *
 * Read by the server (GET /api/agent-catalog) and, later, by the browser: types and plain data only.
 */
import type { UsageProviderId } from "./usage.ts";

export type CatalogPlatform = "macos" | "linux" | "windows";
export const CATALOG_PLATFORMS: readonly CatalogPlatform[] = ["macos", "linux", "windows"];

/** The shell a command is typed into: POSIX sh/bash, PowerShell, or Windows' cmd.exe. */
export type InstallShell = "posix" | "powershell" | "cmd";

/** A program a command needs before it runs, and the oldest version that works where the vendor names one. */
export interface InstallRequirement {
  tool: "curl" | "bash" | "sh" | "tar" | "git" | "node" | "npm" | "brew" | "winget" | "uv" | "pipx" | "python" | "make" | "c++" | "powershell";
  min?: string;
}

/** A clean-PC run of a command: where, when, and whether the agent then answered its version flag. */
export interface CommandTest {
  /** YYYY-MM-DD */
  on: string;
  /** the clean PC, e.g. "docker ubuntu:24.04 x64, no Node" */
  where: string;
  result: "ok" | "failed";
  note?: string;
}

export interface InstallMethod {
  shell: InstallShell;
  /** the command as the vendor prints it (steps the vendor lists one after another are joined with && or ;) */
  command: string;
  requires: readonly InstallRequirement[];
  /** whether it may ask for administrator rights or sudo, on any official path (a missing prerequisite included) */
  admin: boolean;
  /** what goes wrong on a clean PC, in plain words, and what to do instead */
  known_issues: readonly string[];
  tested: readonly CommandTest[];
}

/** One platform's official command, then the vendor's other official ones. */
export interface PlatformInstall {
  primary: InstallMethod;
  alternatives: readonly InstallMethod[];
}

export interface CatalogSource {
  url: string;
  /** when the page was read, YYYY-MM-DD */
  checked: string;
}

export interface AgentCatalogEntry {
  /** the agent kind, as herdr and SUPPORTED_AGENT_KINDS name it */
  id: string;
  name: string;
  vendor: string;
  /** a coding agent run in a pane, or an assistant that keeps running and answers from a messenger */
  kind: "harness" | "assistant";
  /** one line, plain words */
  description: string;
  install: Readonly<Record<CatalogPlatform, PlatformInstall | null>>;
  /** why a platform has no command; one line for each platform whose install is null */
  no_install: Readonly<Partial<Record<CatalogPlatform, string>>>;
  /** every URL a command fetches starts with one of these */
  url_prefixes: readonly string[];
  /** every package a command installs, as manager:name (npm:@openai/codex, brew:codex, winget:Anthropic.ClaudeCode) */
  packages: readonly string[];
  sources: readonly CatalogSource[];
  detect: {
    /** the executables that mean it is installed, in the order they are looked for */
    binaries: readonly string[];
    /**
     * other executables it needs to run, looked for the same way: while one is missing it reads as not
     * installed (DeepSeek Harness: dsh-tui found, but not the dsh launcher it starts sessions with)
     */
    needs?: readonly string[];
    version_args: readonly string[];
    /** how long its version flag may take, when longer than the detector's default (5 s) */
    version_timeout_ms?: number;
    /** platforms where finding the binary proves nothing (another program has its name), or where Ovis cannot start it, and why */
    unreliable_on?: Readonly<Partial<Record<CatalogPlatform, string>>>;
    /**
     * where the vendor's installer puts the binary, looked in when PATH has no such binary: an install
     * often adds its folder to PATH only for terminals opened afterwards. `~/` is the user's home;
     * on Windows `%NAME%/` is that environment variable (LOCALAPPDATA, USERPROFILE).
     */
    install_dirs?: Readonly<Partial<Record<CatalogPlatform, readonly string[]>>>;
  };
  /** null: it needs no sign-in */
  sign_in: {
    /** the account sign-in Ovis already runs (Settings → Agents), when it has one for this agent */
    provider: UsageProviderId | null;
    /** the agent's own sign-in command, outside its TUI */
    command: readonly string[] | null;
    /** the sign-in inside the agent, e.g. "/login" */
    in_agent: string | null;
    /** environment variables it takes a key from instead */
    api_keys: readonly string[];
    /** whether it does nothing useful before a sign-in */
    required: boolean;
  } | null;
  /** what to know once it is installed, in plain words */
  after_install: readonly string[];
  /** the oldest version Ovis's own features for this agent work with, and which feature */
  min_version: { version: string; reason: string } | null;
}

/** What GET /api/agent-catalog found for one agent on the PC it asked. */
export interface AgentInstallState {
  /** null: this platform cannot tell (detect.unreliable_on) */
  installed: boolean | null;
  /** the binary that was found */
  binary: string | null;
  /** false: found only in the installer's folder (detect.install_dirs), not on PATH: a new terminal finds it */
  on_path: boolean | null;
  version: string | null;
  /**
   * why an installed agent has no version: its flag ran too long (timeout), succeeded without one on
   * stdout (unreadable), or did not start or exited with an error (failed: a broken install)
   */
  version_error: "timeout" | "unreadable" | "failed" | null;
  meets_min_version: boolean | null;
}

/** One catalog entry as a PC answers it: its own platform's commands only, and what it found. */
export interface AgentCatalogRow extends Omit<AgentCatalogEntry, "install" | "no_install"> {
  install: PlatformInstall | null;
  no_install: string | null;
  state: AgentInstallState;
}

/** What POST /api/agent-catalog/install or /sign-in answers: the tab it opened, and the exact text typed there. */
export interface AgentTabStarted {
  pane_id: string;
  workspace_id: string;
  command: string;
  shell: InstallShell;
}

export interface AgentCatalogResponse {
  /** null: a platform the catalog has no commands for */
  platform: CatalogPlatform | null;
  agents: AgentCatalogRow[];
}

/** One entry as a PC on `platform` answers it, with what that PC found (server/agent-catalog-routes.ts, the demo). */
export function catalogRow({ install, no_install, ...entry }: AgentCatalogEntry, platform: CatalogPlatform | null, state: AgentInstallState): AgentCatalogRow {
  if (platform === null) return { ...entry, install: null, no_install: "Ovis has no install commands for this operating system.", state };
  return { ...entry, install: install[platform], no_install: install[platform] === null ? no_install[platform] ?? null : null, state };
}

/**
 * Whether the agent is there and runs: found, and its version flag neither failed nor hung. One whose
 * version cannot be read still runs; one whose flag fails (a wrapper's missing target) does not, and
 * is never offered as ready.
 */
export function agentRuns(state: AgentInstallState): boolean {
  return state.installed === true && state.version_error !== "failed" && state.version_error !== "timeout";
}

/** The catalog platform of a Node `process.platform`. */
export function catalogPlatform(platform: string): CatalogPlatform | null {
  return platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
}

const VERSION = /\d+\.\d+(?:\.\d+)?/;

/** The first dotted version in what a version flag printed ("codex-cli 0.163.0", "omp/18.8.7", "2.1.311 (Claude Code)"). */
export function parseVersion(output: string): string | null {
  return VERSION.exec(output)?.[0] ?? null;
}

/** Whether `version` is `min` or later, comparing the dotted numbers; a missing part counts as 0. */
export function meetsMinVersion(version: string, min: string): boolean {
  const have = version.split(".").map(Number);
  const need = min.split(".").map(Number);
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    const left = have[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Every address a command names, whatever its scheme: a quote, a pipe, a semicolon or a bracket ends one. */
const URL_IN_COMMAND = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'|;)]+/gi;
/** The package managers a catalog command may install with, and the packages each install names (npm takes several at once). */
const PACKAGE_INSTALLS: readonly (readonly [string, RegExp])[] = [
  ["npm", /\bnpm[ \t]+(?:install|i)[ \t]+-g((?:[ \t]+[^\s&|;]+)+)/g],
  ["brew", /\bbrew\s+install\s+(?:--cask\s+)?(\S+)/g],
  ["winget", /\bwinget\s+install\s+(\S+)/g],
  ["uv", /\buv\s+tool\s+install\s+(\S+)/g],
  ["pipx", /\bpipx\s+install\s+(\S+)/g],
];
/** An npm spec without its version: `@opencode/cli@latest` is `@opencode/cli`. */
const npmName = (spec: string): string => spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]!;
/**
 * Every command the catalog may hold, as "platform|command", byte for byte. A command is accepted
 * only when it is in this list exactly: nothing parses shell, so nothing can be added before or
 * after it, and no version, argument or space can change. Changing or adding a command means
 * changing it here too, after reading the vendor's page (docs/agent-catalog.md).
 */
export const APPROVED_COMMANDS: ReadonlySet<string> = new Set([
  "macos|curl -fsSL https://claude.ai/install.sh | bash",
  "macos|brew install --cask claude-code",
  "linux|curl -fsSL https://claude.ai/install.sh | bash",
  "linux|brew install --cask claude-code",
  "windows|irm https://claude.ai/install.ps1 | iex",
  "windows|curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd",
  "windows|winget install Anthropic.ClaudeCode",
  "macos|curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  "macos|npm install -g @openai/codex",
  "macos|brew install --cask codex",
  "linux|curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  "linux|npm install -g @openai/codex",
  "windows|powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"",
  "windows|npm install -g @openai/codex",
  "macos|curl -fsSL https://gh.io/copilot-install | bash",
  "macos|brew install copilot-cli",
  "macos|npm install -g @github/copilot",
  "linux|curl -fsSL https://gh.io/copilot-install | bash",
  "linux|brew install copilot-cli",
  "linux|npm install -g @github/copilot",
  "windows|winget install GitHub.Copilot",
  "windows|npm install -g @github/copilot",
  "macos|curl -fsSL https://opencode.ai/v2/install | bash",
  "macos|brew install anomalyco/tap/opencode-v2",
  "macos|npm i -g @opencode/cli@latest",
  "linux|curl -fsSL https://opencode.ai/v2/install | bash",
  "linux|brew install anomalyco/tap/opencode-v2",
  "linux|npm i -g @opencode/cli@latest",
  "windows|npm i -g @opencode/cli@latest",
  "macos|curl -fsSL https://cli.devin.ai/install.sh | bash",
  "macos|brew install --cask devin-cli",
  "linux|curl -fsSL https://cli.devin.ai/install.sh | bash",
  "windows|irm https://static.devin.ai/cli/setup.ps1 | iex",
  "macos|curl -fsSL https://x.ai/cli/install.sh | bash",
  "linux|curl -fsSL https://x.ai/cli/install.sh | bash",
  "windows|irm https://x.ai/cli/install.ps1 | iex",
  "macos|curl -fsSL https://antigravity.google/cli/install.sh | bash",
  "linux|curl -fsSL https://antigravity.google/cli/install.sh | bash",
  "windows|irm https://antigravity.google/cli/install.ps1 | iex",
  "windows|curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd",
  "macos|curl -fsSL https://omp.sh/install | sh",
  "linux|curl -fsSL https://omp.sh/install | sh",
  "windows|irm https://omp.sh/install.ps1 | iex",
  "macos|curl -fsSL https://get.omo.dev/install.sh | bash",
  "linux|curl -fsSL https://get.omo.dev/install.sh | bash",
  "windows|irm https://get.omo.dev/install.ps1 | iex",
  "macos|curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh && sh gjc-install.sh",
  "linux|curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh && sh gjc-install.sh",
  "windows|Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.ps1 -OutFile gjc-install.ps1; powershell -File gjc-install.ps1",
  "macos|curl -fsSL https://pi.dev/install.sh | sh",
  "linux|curl -fsSL https://pi.dev/install.sh | sh",
  "windows|powershell -c \"irm https://pi.dev/install.ps1 | iex\"",
  "macos|npm install -g @letta-ai/letta-code",
  "macos|uv tool install letta",
  "macos|pipx install letta",
  "linux|npm install -g @letta-ai/letta-code",
  "linux|uv tool install letta",
  "linux|pipx install letta",
  "windows|npm install -g @letta-ai/letta-code",
  "windows|uv tool install letta",
  "macos|npm i -g command-code",
  "linux|npm i -g command-code",
  "windows|npm i -g command-code",
  "macos|curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  "linux|curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  "windows|iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
  "macos|npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui",
  "linux|npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui",
]);

/** An allowed address: HTTPS, a host, and a path on it, so a prefix can never stand for a whole host. */
const PREFIX = /^https:\/\/[a-z0-9.-]+\/\S+$/;

/**
 * Why an entry's commands are not the vendor's own, one line each; none when they are. Every command
 * must be in APPROVED_COMMANDS for its platform, byte for byte. As a second, consistency check, every
 * address it names must be HTTPS under one of `url_prefixes`, every package it installs must be in
 * `packages`, and it must not use sudo. The catalog's test holds every entry to it, and the install
 * flow checks a command again before it types it.
 */
export function commandProblems(entry: AgentCatalogEntry): string[] {
  const problems: string[] = [];
  for (const prefix of entry.url_prefixes) if (!PREFIX.test(prefix)) problems.push(`${entry.id}: ${prefix} is not an HTTPS address with a path`);
  for (const platform of CATALOG_PLATFORMS) {
    const install = entry.install[platform];
    if (install === null) continue;
    for (const { command } of [install.primary, ...install.alternatives]) {
      const at = (what: string) => problems.push(`${entry.id} ${platform}: ${what}: ${command}`);
      if (!APPROVED_COMMANDS.has(`${platform}|${command}`)) at("is not one of the approved commands, byte for byte");
      if (/\bsudo\b/.test(command)) at("asks for sudo");
      const urls = command.match(URL_IN_COMMAND) ?? [];
      for (const url of urls) {
        if (!url.startsWith("https://")) at(`fetches ${url}, not over HTTPS`);
        else if (!entry.url_prefixes.some((prefix) => url.startsWith(prefix))) at(`fetches ${url}, not one of the vendor's addresses`);
      }
      let installs = 0;
      for (const [manager, pattern] of PACKAGE_INSTALLS) {
        for (const match of command.matchAll(pattern)) {
          for (const spec of match[1]!.trim().split(/[ \t]+/)) {
            // a flag after the packages (--ignore-scripts, --prefix) changes what the install does
            if (spec.startsWith("-")) { at(`passes ${manager} ${spec}, which the vendor's command does not`); continue; }
            installs++;
            const name = manager === "npm" ? npmName(spec) : spec;
            if (!entry.packages.includes(`${manager}:${name}`)) at(`installs ${manager}:${name}, not one of the vendor's packages`);
          }
        }
      }
      if (urls.length === 0 && installs === 0) at("names no address or package it installs from");
    }
  }
  return problems;
}

const CHECKED = "2026-10-29";
const source = (url: string): CatalogSource => ({ url, checked: CHECKED });
const method = (shell: InstallShell, command: string, requires: readonly InstallRequirement[] = [], extra: Partial<Pick<InstallMethod, "admin" | "known_issues" | "tested">> = {}): InstallMethod =>
  ({ shell, command, requires, admin: extra.admin ?? false, known_issues: extra.known_issues ?? [], tested: extra.tested ?? [] });
const only = (primary: InstallMethod, ...alternatives: InstallMethod[]): PlatformInstall => ({ primary, alternatives });

const DEVIN_LOGIN = "Ends by starting its own sign-in (devin setup): with no browser it stops at \"Login canceled\" and exits 1, or waits until you press Ctrl+C. Devin is installed either way: sign in afterwards with devin auth login.";
const OMP_BUN = "Stops when an older Bun (before 1.4.4) is on PATH, as Ovis's own installer may have put there: run bun upgrade first.";
const PI_NODE = "Needs Node.js 22.19 or later: without it, it asks in the terminal whether to install it, and without a terminal it stops.";
const PI_NODE_SUDO = "Needs Node.js 22.19 or later: without it, it asks in the terminal whether to install it (which may ask for sudo), and without a terminal it stops.";
const DSH_PNPM = "dsh-tui sets up its dsh profile with pnpm on its first start: without pnpm it stops there. Install it first: npm install -g pnpm.";
const DSH_WINDOWS = "Ovis cannot start DeepSeek Harness on Windows yet, so it neither installs it nor offers it there.";
const DSH_VERSIONS = "dsh 0.2.1-rc.5 refuses dsh-tui 0.17.0 as an untested pair on its first start (\"nothing was installed\"). To accept that risk, run the command dsh prints, dsh plugin --profile dsh-tui allow-version @deepseek-harness-tui/dsh-tui@0.17.0 --dsh-version 0.2.1-rc.5 --accept-risk, then start dsh-tui again.";
const CURL_BASH: readonly InstallRequirement[] = [{ tool: "curl" }, { tool: "bash" }];
const CURL_SH: readonly InstallRequirement[] = [{ tool: "curl" }, { tool: "sh" }];
const POWERSHELL: readonly InstallRequirement[] = [{ tool: "powershell" }];

/**
 * Clean-PC runs of the catalog's commands, by "platform|command" with the command exactly as listed:
 * a changed command no longer carries the runs of its old text. How to run one: docs/agent-catalog.md.
 */
export const COMMAND_TESTS: Readonly<Record<string, readonly CommandTest[]>> = {
  "windows|irm https://claude.ai/install.ps1 | iex": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "ok",
      note: "2.1.312, in %USERPROFILE%\\.local\\bin, which it does not add to PATH"
    }
  ],
  "windows|powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "ok",
      note: "0.165.0"
    }
  ],
  "windows|irm https://x.ai/cli/install.ps1 | iex": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "ok",
      note: "1.0.70"
    }
  ],
  "windows|irm https://antigravity.google/cli/install.ps1 | iex": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "ok",
      note: "1.4.10"
    }
  ],
  "windows|powershell -c \"irm https://pi.dev/install.ps1 | iex\"": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "failed",
      note: "no terminal and no Node: it waits at its question whether to install Node"
    }
  ],
  "windows|irm https://omp.sh/install.ps1 | iex": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "failed",
      note: "an older Bun (1.4.2) on PATH: it asks for Bun 1.4.4 or later"
    }
  ],
  "windows|irm https://get.omo.dev/install.ps1 | iex": [
    {
      on: "2026-10-29",
      where: "Windows 11 VM; elevated; Windows PowerShell 5.1; no Node",
      result: "failed",
      note: "refuses an elevated shell, as its docs say"
    }
  ],
  "linux|curl -fsSL https://claude.ai/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "2.1.312"
    }
  ],
  "macos|curl -fsSL https://claude.ai/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "2.1.312"
    }
  ],
  "linux|curl -fsSL https://chatgpt.com/codex/install.sh | sh": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "0.165.0"
    }
  ],
  "macos|curl -fsSL https://chatgpt.com/codex/install.sh | sh": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "0.165.0"
    }
  ],
  "linux|npm install -g @openai/codex": [
    {
      on: "2026-10-29",
      where: "docker node:24-bookworm-slim x64; Node 24, npm; no Python or build tools",
      result: "ok",
      note: "0.165.0"
    }
  ],
  "linux|curl -fsSL https://gh.io/copilot-install | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "1.0.105"
    }
  ],
  "macos|curl -fsSL https://gh.io/copilot-install | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "1.0.105"
    }
  ],
  "linux|npm install -g @github/copilot": [
    {
      on: "2026-10-29",
      where: "docker node:24-bookworm-slim x64; Node 24, npm; no Python or build tools",
      result: "ok",
      note: "1.0.105"
    }
  ],
  "linux|curl -fsSL https://opencode.ai/v2/install | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "2.2.0"
    }
  ],
  "macos|curl -fsSL https://opencode.ai/v2/install | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "2.2.0"
    }
  ],
  "linux|npm i -g @opencode/cli@latest": [
    {
      on: "2026-10-29",
      where: "docker node:24-bookworm-slim x64; Node 24, npm; no Python or build tools",
      result: "ok",
      note: "2.2.0"
    }
  ],
  "linux|curl -fsSL https://cli.devin.ai/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "3000.11.228; the installer exits 1 after its sign-in finds no browser"
    }
  ],
  "macos|curl -fsSL https://cli.devin.ai/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "3000.11.228; the installer exits 1 after its sign-in finds no browser"
    }
  ],
  "linux|curl -fsSL https://x.ai/cli/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "1.0.70"
    }
  ],
  "macos|curl -fsSL https://x.ai/cli/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "1.0.70"
    }
  ],
  "linux|curl -fsSL https://antigravity.google/cli/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "1.4.10"
    }
  ],
  "macos|curl -fsSL https://antigravity.google/cli/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "1.4.10"
    }
  ],
  "linux|curl -fsSL https://omp.sh/install | sh": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "18.13.3"
    }
  ],
  "macos|curl -fsSL https://omp.sh/install | sh": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "18.13.3"
    }
  ],
  "linux|curl -fsSL https://get.omo.dev/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "5.1.51"
    }
  ],
  "macos|curl -fsSL https://get.omo.dev/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "5.1.51"
    }
  ],
  "linux|curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh && sh gjc-install.sh": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "ok",
      note: "0.19.0"
    }
  ],
  "macos|curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh && sh gjc-install.sh": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "0.19.0"
    }
  ],
  "linux|curl -fsSL https://pi.dev/install.sh | sh": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "failed",
      note: "no terminal and no Node: it stops and asks for Node.js 22.19 first"
    },
    {
      on: "2026-10-29",
      where: "docker node:24-bookworm-slim x64; Node 24",
      result: "ok",
      note: "1.4.0, in ~/.pi/agent/bin, not on PATH until a new shell"
    }
  ],
  "macos|curl -fsSL https://pi.dev/install.sh | sh": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "failed",
      note: "no terminal and no Node: it stops and asks for Node.js 22.19 first"
    }
  ],
  "linux|npm install -g @letta-ai/letta-code": [
    {
      on: "2026-10-29",
      where: "docker node:24-bookworm-slim x64; Node 24, npm; no Python or build tools",
      result: "failed",
      note: "node-pty has no Linux prebuild; node-gyp finds no Python"
    }
  ],
  "linux|uv tool install letta": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; uv from astral.sh; normal user",
      result: "ok",
      note: "0.34.12 (npm has 0.34.23)"
    }
  ],
  "linux|npm i -g command-code": [
    {
      on: "2026-10-29",
      where: "docker node:24-bookworm-slim x64; Node 24, npm; no Python or build tools",
      result: "ok",
      note: "1.88.2"
    }
  ],
  "linux|curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "docker ubuntu:24.04 x64; curl, git, tar, unzip; no Node; normal user",
      result: "failed",
      note: "the Node it downloads needs libatomic1, which it can only add with sudo"
    }
  ],
  "macos|curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash": [
    {
      on: "2026-10-29",
      where: "macOS 27 arm64 (test Mac); no Node or Homebrew; a throwaway HOME",
      result: "ok",
      note: "0.22.5"
    }
  ],
  "linux|npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui": [
    {
      on: "2026-11-01",
      where: "docker node:24-bookworm-slim x64; Node 24, npm; no Python, build tools or pnpm",
      result: "ok",
      note: "dsh 0.2.1-rc.5, dsh-tui 0.17.0; its first start needs pnpm, and on a fresh dsh home dsh refuses that dsh-tui until allow-version --accept-risk (checked on Linux 2026-11-01)"
    }
  ]
};

const CATALOG_ENTRIES: readonly AgentCatalogEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    kind: "harness",
    description: "Anthropic's coding agent: reads your code, edits files and runs commands.",
    install: {
      macos: only(method("posix", "curl -fsSL https://claude.ai/install.sh | bash", CURL_BASH), method("posix", "brew install --cask claude-code", [{ tool: "brew" }])),
      linux: only(method("posix", "curl -fsSL https://claude.ai/install.sh | bash", CURL_BASH), method("posix", "brew install --cask claude-code", [{ tool: "brew" }])),
      windows: only(
        method("powershell", "irm https://claude.ai/install.ps1 | iex", POWERSHELL, { known_issues: ["Without Git for Windows, Claude Code uses PowerShell instead of Bash for its commands."] }),
        method("cmd", "curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd", [{ tool: "curl" }]),
        method("powershell", "winget install Anthropic.ClaudeCode", [{ tool: "winget" }]),
      ),
    },
    no_install: {},
    url_prefixes: ["https://claude.ai/install.sh", "https://claude.ai/install.ps1", "https://claude.ai/install.cmd"],
    packages: ["brew:claude-code", "winget:Anthropic.ClaudeCode"],
    sources: [source("https://code.claude.com/docs/en/quickstart")],
    detect: { binaries: ["claude"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"], windows: ["%USERPROFILE%/.local/bin"] } },
    sign_in: { provider: "claude", command: ["claude", "auth", "login"], in_agent: "/login", api_keys: ["ANTHROPIC_API_KEY"], required: true },
    after_install: ["Open a new terminal before running it: the installer adds it to PATH for new shells."],
    min_version: { version: "2.1.284", reason: "Ultracode in New workspace" },
  },
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    kind: "harness",
    description: "OpenAI's coding agent for the terminal.",
    install: {
      macos: only(method("posix", "curl -fsSL https://chatgpt.com/codex/install.sh | sh", CURL_SH), method("posix", "npm install -g @openai/codex", [{ tool: "node" }, { tool: "npm" }]), method("posix", "brew install --cask codex", [{ tool: "brew" }])),
      linux: only(method("posix", "curl -fsSL https://chatgpt.com/codex/install.sh | sh", CURL_SH), method("posix", "npm install -g @openai/codex", [{ tool: "node" }, { tool: "npm" }])),
      windows: only(method("powershell", "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"", POWERSHELL), method("powershell", "npm install -g @openai/codex", [{ tool: "node" }, { tool: "npm" }])),
    },
    no_install: {},
    url_prefixes: ["https://chatgpt.com/codex/install.sh", "https://chatgpt.com/codex/install.ps1"],
    packages: ["npm:@openai/codex", "brew:codex"],
    sources: [source("https://developers.openai.com/codex/cli")],
    detect: { binaries: ["codex"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"], windows: ["%LOCALAPPDATA%/Programs/OpenAI/Codex/bin"] } },
    sign_in: { provider: "codex", command: ["codex", "login"], in_agent: null, api_keys: [], required: true },
    after_install: [],
    min_version: { version: "0.157.0", reason: "skills in the composer menu, read from Codex's app-server" },
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    vendor: "GitHub",
    kind: "harness",
    description: "GitHub Copilot's coding agent in the terminal, with your Copilot plan.",
    install: {
      macos: only(method("posix", "curl -fsSL https://gh.io/copilot-install | bash", CURL_BASH, { known_issues: ["Run as root it installs to /usr/local/bin; otherwise to ~/.local/bin, which must be on PATH."] }), method("posix", "brew install copilot-cli", [{ tool: "brew" }]), method("posix", "npm install -g @github/copilot", [{ tool: "node" }, { tool: "npm" }])),
      linux: only(method("posix", "curl -fsSL https://gh.io/copilot-install | bash", CURL_BASH, { known_issues: ["Run as root it installs to /usr/local/bin; otherwise to ~/.local/bin, which must be on PATH."] }), method("posix", "brew install copilot-cli", [{ tool: "brew" }]), method("posix", "npm install -g @github/copilot", [{ tool: "node" }, { tool: "npm" }])),
      windows: only(method("powershell", "winget install GitHub.Copilot", [{ tool: "winget" }, { tool: "powershell", min: "6" }]), method("powershell", "npm install -g @github/copilot", [{ tool: "node" }, { tool: "npm" }])),
    },
    no_install: {},
    url_prefixes: ["https://gh.io/copilot-install"],
    packages: ["brew:copilot-cli", "npm:@github/copilot", "winget:GitHub.Copilot"],
    sources: [source("https://github.com/github/copilot-cli/blob/84ee80ea6490ce02d6000439356a609fcefbb9ae/README.md")],
    detect: { binaries: ["copilot"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: "copilot", command: ["copilot", "login"], in_agent: "/login", api_keys: ["GH_TOKEN", "GITHUB_TOKEN"], required: true },
    after_install: ["Needs an active GitHub Copilot plan."],
    min_version: null,
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "Anomaly (SST)",
    kind: "harness",
    description: "Open-source coding agent that works with many model providers.",
    install: {
      macos: only(method("posix", "curl -fsSL https://opencode.ai/v2/install | bash", CURL_BASH), method("posix", "brew install anomalyco/tap/opencode-v2", [{ tool: "brew" }]), method("posix", "npm i -g @opencode/cli@latest", [{ tool: "node" }, { tool: "npm" }])),
      linux: only(method("posix", "curl -fsSL https://opencode.ai/v2/install | bash", CURL_BASH), method("posix", "brew install anomalyco/tap/opencode-v2", [{ tool: "brew" }]), method("posix", "npm i -g @opencode/cli@latest", [{ tool: "node" }, { tool: "npm" }])),
      windows: only(method("powershell", "npm i -g @opencode/cli@latest", [{ tool: "node" }, { tool: "npm" }])),
    },
    no_install: {},
    url_prefixes: ["https://opencode.ai/v2/install"],
    packages: ["brew:anomalyco/tap/opencode-v2", "npm:@opencode/cli"],
    sources: [source("https://github.com/anomalyco/opencode/blob/f023f7c36c090260a49c6e4da0ff69cbbd10c168/README.md"), source("https://opencode.ai/docs/cli/")],
    detect: { binaries: ["opencode"], version_args: ["--version"], install_dirs: { macos: ["~/.opencode/bin"], linux: ["~/.opencode/bin"] } },
    sign_in: { provider: "opencode", command: ["opencode", "auth", "login"], in_agent: null, api_keys: [], required: false },
    after_install: [
      "OpenCode 1 and 2 are both run as opencode: installing 2 replaces 1.",
      "Its installer for macOS and Linux puts ~/.opencode/bin first on PATH in your shell's startup file (~/.bashrc, ~/.zshrc): an opencode command of your own elsewhere (a wrapper in ~/.local/bin) is no longer the one that runs.",
    ],
    min_version: { version: "2.0.0", reason: "answering its questions from Chat" },
  },
  {
    id: "devin",
    name: "Devin CLI",
    vendor: "Cognition",
    kind: "harness",
    description: "Cognition's Devin, working in your local terminal.",
    install: {
      macos: only(method("posix", "curl -fsSL https://cli.devin.ai/install.sh | bash", CURL_BASH, { known_issues: [DEVIN_LOGIN] }), method("posix", "brew install --cask devin-cli", [{ tool: "brew" }])),
      linux: only(method("posix", "curl -fsSL https://cli.devin.ai/install.sh | bash", CURL_BASH, { known_issues: [DEVIN_LOGIN] })),
      windows: only(method("powershell", "irm https://static.devin.ai/cli/setup.ps1 | iex", POWERSHELL)),
    },
    no_install: {},
    url_prefixes: ["https://cli.devin.ai/install.sh", "https://static.devin.ai/cli/setup.ps1"],
    packages: ["brew:devin-cli"],
    sources: [source("https://docs.devin.ai/cli/index"), source("https://docs.devin.ai/cli/reference/commands")],
    detect: { binaries: ["devin"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: null, command: ["devin", "auth", "login"], in_agent: null, api_keys: [], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "grok",
    name: "Grok Build",
    vendor: "xAI",
    kind: "harness",
    description: "xAI's coding agent for the terminal.",
    install: {
      macos: only(method("posix", "curl -fsSL https://x.ai/cli/install.sh | bash", CURL_BASH)),
      linux: only(method("posix", "curl -fsSL https://x.ai/cli/install.sh | bash", CURL_BASH)),
      windows: only(method("powershell", "irm https://x.ai/cli/install.ps1 | iex", POWERSHELL)),
    },
    no_install: {},
    url_prefixes: ["https://x.ai/cli/install.sh", "https://x.ai/cli/install.ps1"],
    packages: [],
    sources: [source("https://docs.x.ai/build/overview"), source("https://github.com/xai-org/grok-build")],
    detect: { binaries: ["grok"], version_args: ["--version"], install_dirs: { macos: ["~/.grok/bin", "~/.local/bin"], linux: ["~/.grok/bin", "~/.local/bin"], windows: ["%USERPROFILE%/.grok/bin"] } },
    sign_in: { provider: "grok", command: ["grok", "login"], in_agent: null, api_keys: ["XAI_API_KEY"], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "agy",
    name: "Antigravity",
    vendor: "Google",
    kind: "harness",
    description: "Google Antigravity's agent, from the terminal.",
    install: {
      macos: only(method("posix", "curl -fsSL https://antigravity.google/cli/install.sh | bash", CURL_BASH)),
      linux: only(method("posix", "curl -fsSL https://antigravity.google/cli/install.sh | bash", CURL_BASH)),
      windows: only(method("powershell", "irm https://antigravity.google/cli/install.ps1 | iex", POWERSHELL), method("cmd", "curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd", [{ tool: "curl" }])),
    },
    no_install: {},
    url_prefixes: ["https://antigravity.google/cli/install.sh", "https://antigravity.google/cli/install.ps1", "https://antigravity.google/cli/install.cmd"],
    packages: [],
    sources: [source("https://antigravity.google/docs/getting-started?tab=cli"), source("https://github.com/google-antigravity/antigravity-cli")],
    detect: { binaries: ["agy"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"], windows: ["%LOCALAPPDATA%/agy/bin"] } },
    sign_in: { provider: "antigravity", command: null, in_agent: "Google sign-in on first start", api_keys: ["GEMINI_API_KEY"], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "omp",
    name: "Oh My Pi",
    vendor: "can1357",
    kind: "harness",
    description: "A coding agent with IDE features and built-in tools.",
    install: {
      macos: only(method("posix", "curl -fsSL https://omp.sh/install | sh", CURL_SH, { known_issues: [OMP_BUN] })),
      linux: only(method("posix", "curl -fsSL https://omp.sh/install | sh", CURL_SH, { known_issues: [OMP_BUN] })),
      windows: only(method("powershell", "irm https://omp.sh/install.ps1 | iex", POWERSHELL, { known_issues: [OMP_BUN] })),
    },
    no_install: {},
    url_prefixes: ["https://omp.sh/install"],
    packages: [],
    sources: [source("https://github.com/can1357/oh-my-pi/blob/b0756921ed231869ea92feef0056629a429d3fe1/README.md"), source("https://omp.sh")],
    detect: { binaries: ["omp"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: null, command: null, in_agent: "/login", api_keys: [], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "omo",
    name: "OmO",
    vendor: "Yeongyu Kim",
    kind: "harness",
    description: "A coding agent that plans, delegates to sub-agents and checks its own work.",
    install: {
      macos: only(method("posix", "curl -fsSL https://get.omo.dev/install.sh | bash", CURL_BASH, { known_issues: ["Refuses to run as root: run it as your own user, without sudo."] })),
      linux: only(method("posix", "curl -fsSL https://get.omo.dev/install.sh | bash", CURL_BASH, { known_issues: ["Refuses to run as root: run it as your own user, without sudo."] })),
      windows: only(method("powershell", "irm https://get.omo.dev/install.ps1 | iex", POWERSHELL, { known_issues: ["Refuses to run as Administrator: use a normal PowerShell window."] })),
    },
    no_install: {},
    url_prefixes: ["https://get.omo.dev/install.sh", "https://get.omo.dev/install.ps1"],
    packages: [],
    sources: [source("https://omo.dev/docs/install"), source("https://github.com/code-yeongyu/oh-my-openagent/blob/f6060b50fdaea42e709abadeb482ec32a12edb63/README.md")],
    detect: { binaries: ["omo"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: null, command: null, in_agent: "/login", api_keys: [], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "gjc",
    name: "Gajae Code",
    vendor: "Yeachan Heo",
    kind: "harness",
    description: "A coding agent that uses your coding-plan subscriptions or API keys.",
    install: {
      macos: only(method("posix", "curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh && sh gjc-install.sh", CURL_SH)),
      linux: only(method("posix", "curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh && sh gjc-install.sh", CURL_SH, { known_issues: ["Prebuilt for glibc Linux only (x64, arm64): Alpine and other musl systems are not supported."] })),
      windows: only(method("powershell", "Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.ps1 -OutFile gjc-install.ps1; powershell -File gjc-install.ps1", POWERSHELL, { known_issues: ["Its shell tools need a bash: Git Bash, WSL, Cygwin or MSYS2."] })),
    },
    no_install: {},
    url_prefixes: ["https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh", "https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.ps1"],
    packages: [],
    sources: [source("https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/install.md"), source("https://github.com/Yeachan-Heo/gajae-code/blob/86cbbabff39336ccc67adccc76936cb5d951fe01/README.md")],
    detect: { binaries: ["gjc"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: null, command: null, in_agent: "/login", api_keys: [], required: true },
    after_install: ["For Chat and done alerts, install Ovis's GJC extension and restart GJC (Supported agents in the guide)."],
    min_version: null,
  },
  {
    id: "pi",
    name: "pi",
    vendor: "Mario Zechner",
    kind: "harness",
    description: "A minimal, extensible coding agent.",
    install: {
      macos: only(method("posix", "curl -fsSL https://pi.dev/install.sh | sh", CURL_SH, { admin: true, known_issues: [PI_NODE_SUDO] })),
      linux: only(method("posix", "curl -fsSL https://pi.dev/install.sh | sh", CURL_SH, { admin: true, known_issues: [PI_NODE_SUDO] })),
      windows: only(method("powershell", "powershell -c \"irm https://pi.dev/install.ps1 | iex\"", POWERSHELL, { known_issues: [PI_NODE] })),
    },
    no_install: {},
    url_prefixes: ["https://pi.dev/install.sh", "https://pi.dev/install.ps1"],
    packages: [],
    sources: [source("https://github.com/badlogic/pi-mono/blob/e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a/README.md")],
    detect: { binaries: ["pi"], version_args: ["--version"], install_dirs: { macos: ["~/.pi/agent/bin"], linux: ["~/.pi/agent/bin"] } },
    sign_in: { provider: null, command: null, in_agent: "/login", api_keys: [], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "letta",
    name: "Letta Code",
    vendor: "Letta",
    kind: "harness",
    description: "A coding agent with long-term memory.",
    install: {
      macos: only(method("posix", "npm install -g @letta-ai/letta-code", [{ tool: "node", min: "22.19" }, { tool: "npm" }], { known_issues: ["Do not use sudo: a root-owned install cannot update itself."] }), method("posix", "uv tool install letta", [{ tool: "uv" }, { tool: "python", min: "3.9" }], { known_issues: ["The PyPI package can lag the npm one by a few releases."] }), method("posix", "pipx install letta", [{ tool: "pipx" }, { tool: "python", min: "3.9" }])),
      linux: only(
        method("posix", "npm install -g @letta-ai/letta-code", [{ tool: "node", min: "22.19" }, { tool: "npm" }, { tool: "python", min: "3" }, { tool: "make" }, { tool: "c++" }], {
          known_issues: [
            "Fails on Linux without build tools: its node-pty 1.1.0 has no Linux prebuild, so npm compiles it and needs Python 3, make and a C++ compiler (--omit=optional does not help). Install them first, or use uv below.",
            "Do not use sudo: a root-owned install cannot update itself.",
          ],
        }),
        method("posix", "uv tool install letta", [{ tool: "uv" }, { tool: "python", min: "3.9" }], { known_issues: ["The PyPI package can lag the npm one by a few releases."] }),
        method("posix", "pipx install letta", [{ tool: "pipx" }, { tool: "python", min: "3.9" }]),
      ),
      windows: only(method("powershell", "npm install -g @letta-ai/letta-code", [{ tool: "node", min: "22.19" }, { tool: "npm" }]), method("powershell", "uv tool install letta", [{ tool: "uv" }, { tool: "python", min: "3.9" }])),
    },
    no_install: {},
    url_prefixes: [],
    packages: ["npm:@letta-ai/letta-code", "uv:letta", "pipx:letta"],
    sources: [source("https://docs.letta.com/platform/cli"), source("https://github.com/letta-ai/letta-code")],
    detect: { binaries: ["letta"], version_args: ["--version"], install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: null, command: null, in_agent: "/login (Letta Cloud, optional); /connect for model keys", api_keys: [], required: false },
    after_install: ["Start Letta once before `herdr integration install letta`: the integration needs ~/.letta."],
    min_version: null,
  },
  {
    id: "cmd",
    name: "Command Code",
    vendor: "Command Code",
    kind: "harness",
    description: "A coding agent that learns how you like code written.",
    install: {
      macos: only(method("posix", "npm i -g command-code", [{ tool: "node" }, { tool: "npm" }])),
      linux: only(method("posix", "npm i -g command-code", [{ tool: "node" }, { tool: "npm" }])),
      windows: only(method("powershell", "npm i -g command-code", [{ tool: "node" }, { tool: "npm" }], { known_issues: ["Its command is cmd, the name of Windows' own command prompt: Ovis cannot tell on Windows whether it is installed."] })),
    },
    no_install: {},
    url_prefixes: [],
    packages: ["npm:command-code"],
    sources: [source("https://github.com/CommandCodeAI/command-code"), source("https://commandcode.ai/docs/quickstart")],
    detect: { binaries: ["cmd"], version_args: ["--version"], unreliable_on: { windows: "cmd is Windows' own command prompt" } },
    sign_in: { provider: null, command: null, in_agent: "sign-in on first start", api_keys: [], required: true },
    after_install: [],
    min_version: null,
  },
  {
    id: "muse",
    name: "Muse Code",
    vendor: "Meta",
    kind: "harness",
    description: "Meta's coding agent for the terminal.",
    install: { macos: null, linux: null, windows: null },
    no_install: {
      macos: "Meta publishes no public install command for Muse Code.",
      linux: "Meta publishes no public install command for Muse Code.",
      windows: "Meta publishes no public install command for Muse Code.",
    },
    url_prefixes: [],
    packages: [],
    sources: [],
    detect: { binaries: ["muse"], version_args: ["--version"] },
    sign_in: { provider: null, command: null, in_agent: "Meta account sign-in on first start", api_keys: [], required: true },
    after_install: [],
    min_version: null,
  },
  {
    // herdr labels a dsh-tui pane `dsh-tui`, and New tab starts that TUI: dsh itself has no chat in a terminal
    id: "dsh-tui",
    name: "DeepSeek Harness",
    vendor: "DeepSeek",
    kind: "harness",
    description: "DeepSeek's agent harness in a terminal UI. Needs a DeepSeek API key or another provider.",
    install: {
      macos: only(method("posix", "npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui", [{ tool: "node" }, { tool: "npm" }], { known_issues: [DSH_PNPM, DSH_VERSIONS] })),
      linux: only(method("posix", "npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui", [{ tool: "node" }, { tool: "npm" }], { known_issues: [DSH_PNPM, DSH_VERSIONS] })),
      windows: null,
    },
    no_install: { windows: DSH_WINDOWS },
    url_prefixes: [],
    packages: ["npm:@deepseek-ai/dsh", "npm:@deepseek-harness-tui/dsh-tui"],
    sources: [
      { url: "https://github.com/deepseek-ai/deepseek-harness/blob/31ba15da2b7c07408caaa31e30b755acc297234f/README.md", checked: "2026-11-01" },
      { url: "https://github.com/ccch1mneyyy/dsh-TUI/blob/acfe80f10170292a7aa93808b214b5a7b12bc609/README.md", checked: "2026-11-01" },
    ],
    // dsh-tui first: Debian's distributed shell is a /usr/bin/dsh too
    detect: { binaries: ["dsh-tui"], needs: ["dsh"], version_args: ["--version"], unreliable_on: { windows: DSH_WINDOWS } },
    // Sign in opens dsh-tui itself: the key goes into its own first-run prompt; Ovis has no field that asks for it
    sign_in: { provider: null, command: null, in_agent: "on its first start: a DeepSeek API key from https://platform.deepseek.com/api_keys typed into its own prompt, or an OpenAI- or Anthropic-compatible provider", api_keys: ["DEEPSEEK_API_KEY"], required: true },
    after_install: ["It needs a model before it can work: a DeepSeek API key (https://platform.deepseek.com/api_keys) or an OpenAI- or Anthropic-compatible provider, entered in dsh-tui's own first-run prompt: Ovis does not ask for the key."],
    min_version: null,
  },
  {
    id: "hermes",
    name: "Hermes",
    vendor: "Nous Research",
    kind: "assistant",
    description: "An always-on assistant you message from Telegram, Discord and more.",
    install: {
      macos: only(method("posix", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", [{ tool: "curl" }, { tool: "bash" }, { tool: "git" }, { tool: "tar" }])),
      linux: only(method("posix", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", [{ tool: "curl" }, { tool: "bash" }, { tool: "git" }, { tool: "tar" }], { admin: true, known_issues: ["On a minimal Linux the Node it downloads needs libatomic1: install it first (sudo apt-get install -y libatomic1), or the installer asks for sudo to add it."] })),
      windows: only(method("powershell", "iex (irm https://hermes-agent.nousresearch.com/install.ps1)", POWERSHELL)),
    },
    no_install: {},
    url_prefixes: ["https://hermes-agent.nousresearch.com/install.sh", "https://hermes-agent.nousresearch.com/install.ps1"],
    packages: [],
    sources: [source("https://hermes-agent.nousresearch.com/docs/getting-started/installation"), source("https://hermes-agent.nousresearch.com/docs/user-guide/messaging/")],
    // its version flag loads the whole agent: 2.3 to 6.7 s on a busy PC
    detect: { binaries: ["hermes"], version_args: ["--version"], version_timeout_ms: 15_000, install_dirs: { macos: ["~/.local/bin"], linux: ["~/.local/bin"] } },
    sign_in: { provider: null, command: ["hermes", "setup"], in_agent: null, api_keys: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GOOGLE_API_KEY"], required: true },
    after_install: [
      "A messenger needs its own bot token too (Telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS).",
      "To keep it running after you close the terminal: hermes gateway install, then hermes gateway start.",
    ],
    min_version: null,
  },
];

const withTests = (platform: CatalogPlatform, method: InstallMethod): InstallMethod =>
  method.tested.length > 0 ? method : { ...method, tested: COMMAND_TESTS[`${platform}|${method.command}`] ?? [] };

const testedInstall = (platform: CatalogPlatform, install: PlatformInstall | null): PlatformInstall | null =>
  install === null ? null : { primary: withTests(platform, install.primary), alternatives: install.alternatives.map((method) => withTests(platform, method)) };

/** Every agent Ovis can install, each command with its clean-PC runs (COMMAND_TESTS). */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = CATALOG_ENTRIES.map((entry) => ({
  ...entry,
  install: { macos: testedInstall("macos", entry.install.macos), linux: testedInstall("linux", entry.install.linux), windows: testedInstall("windows", entry.install.windows) },
}));
