import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { isBackgroundRole, PANE_TOKEN_NAME, paneTokenRuleMatches, paneTokenSpecs, type AgentRowTokens, type PaneTokenRule, type PaneTokenSpec, ROLE_TOKEN } from "../shared/pane-tokens.ts";

const POLL_MS = 5_000;
/** A config is a short TOML document, not an unbounded log. */
const MAX_CONFIG_BYTES = 1024 * 1024;
/** herdr's canonical agent ids (`rows_by_agent` keys): `claude`, `codex`, `pi` */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT_CONDITIONS = ["equals", "contains", "starts_with"] as const;
const NUMBER_CONDITIONS = ["gt", "lt"] as const;

/**
 * herdr's config.toml, as herdr resolves it (`herdr --help`): HERDR_CONFIG_PATH, else herdr/ under
 * XDG_CONFIG_HOME when it is set (on Windows too, as for its sockets), else under %APPDATA% on
 * Windows and ~/.config elsewhere.
 */
export function herdrConfigPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env["HERDR_CONFIG_PATH"]) return env["HERDR_CONFIG_PATH"];
  const root = env["XDG_CONFIG_HOME"] || (platform === "win32" ? env["APPDATA"] || join(home, "AppData", "Roaming") : join(home, ".config"));
  return join(root, "herdr", "config.toml");
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Line-start BOMs outside strings are config markers; inside multiline strings they are value data. */
function normalizeConfigBom(text: string): string {
  let quote: string | null = null;
  return text.split("\n").map((line) => {
    const normalized = quote === null && line.startsWith("\uFEFF") ? line.slice(1) : line;
    for (let i = 0; i < normalized.length;) {
      const char = normalized[i];
      if (quote === null) {
        if (char === "#") break;
        if (char === '"' || char === "'") {
          quote = normalized.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
          i += quote.length;
        } else i++;
      } else if (quote[0] === '"' && char === "\\") {
        i += 2;
      } else if (normalized.startsWith(quote, i)) {
        i += quote.length;
        // Four or five closing quotes include one or two value quotes, not a new string.
        if (quote.length === 3) while (normalized[i] === quote[0]) i++;
        quote = null;
      } else i++;
    }
    // Single-line strings cannot carry delimiter state into the next line.
    if (quote?.length === 1) quote = null;
    return normalized;
  }).join("\n");
}

/**
 * herdr's config.toml at `path`, parsed, or null when it is no regular file of a config's size, cannot
 * be read whole, or is no TOML. The opened file is checked too: a FIFO swapped in after a stat must not
 * block the server. A file that grew while being read is not taken (a later read takes it whole).
 */
export function readHerdrConfig(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let count = 1; count > 0 && length < buffer.length; length += count) count = readSync(fd, buffer, length, buffer.length - length, null);
    if (length > stat.size) return null;
    return Bun.TOML.parse(normalizeConfigBom(buffer.subarray(0, length).toString("utf8")));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A rule with exactly one condition of its kind, as herdr accepts it; anything else herdr refuses, and is left out. */
function tokenRule(value: unknown): PaneTokenRule | null {
  const rule = table(value);
  if (!rule) return null;
  const text = TEXT_CONDITIONS.filter((key) => rule[key] !== undefined);
  const number = NUMBER_CONDITIONS.filter((key) => rule[key] !== undefined);
  if (text.length + number.length !== 1) return null;
  const hide = rule["hide"] === true ? { hide: true } : {};
  if (text.length === 1) {
    const condition = rule[text[0]!];
    if (typeof condition !== "string") return null;
    return { [text[0]!]: condition, ...(rule["ignore_case"] === true ? { ignore_case: true } : {}), ...hide };
  }
  const condition = rule[number[0]!];
  if (typeof condition !== "number" || !Number.isFinite(condition) || rule["ignore_case"] !== undefined) return null;
  return { [number[0]!]: condition, ...hide };
}

/**
 * herdr tests each place's rules on its own, so a token hidden at its first place may still show at a later one.
 */
function tokenSpecs(rows: unknown): PaneTokenSpec[] | null {
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) return null;
  const specs: PaneTokenSpec[] = [];
  for (const row of rows as unknown[][]) {
    for (const entry of row) {
      const style = table(entry);
      const token = typeof entry === "string" ? entry : style?.["token"];
      if (typeof token !== "string" || !token.startsWith("$")) continue;
      const name = token.slice(1);
      if (!PANE_TOKEN_NAME.test(name)) continue;
      const rules = Array.isArray(style?.["rules"]) ? (style["rules"] as unknown[]).flatMap((rule) => tokenRule(rule) ?? []) : [];
      specs.push(rules.some((rule) => rule.hide) ? { name, rules } : { name });
    }
  }
  return specs;
}

/**
 * The `$name` tokens herdr's `[ui.sidebar.agents]` rows draw, from a parsed config.toml; null when
 * the config sets neither `rows` nor `rows_by_agent`, and the web UI then draws every token.
 */
export function agentRowTokens(config: unknown): AgentRowTokens | null {
  const agents = table(table(table(config)?.["ui"])?.["sidebar"])?.["agents"];
  const layout = table(agents);
  if (!layout) return null;
  const rows = tokenSpecs(layout["rows"]);
  const byAgent = Object.fromEntries(Object.entries(table(layout["rows_by_agent"]) ?? {})
    .filter(([agent]) => AGENT_ID.test(agent))
    .flatMap(([agent, value]) => {
      const specs = tokenSpecs(value);
      return specs === null ? [] : [[agent, specs] as const];
    }));
  if (rows === null && Object.keys(byAgent).length === 0) return null;
  return { rows, by_agent: byAgent };
}

const nonblank = (value: string | null | undefined): string | null => value?.trim() || null;

function hiddenEverywhere(specs: PaneTokenSpec[], name: string, value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const places = specs.filter((spec) => spec.name === name);
  return places.length > 0 && places.every(({ rules }) => rules?.find((rule) => paneTokenRuleMatches(rule, value))?.hide === true);
}

/**
 * The PCs as browsers are told them (#1349): without the token values herdr's rows hide wherever
 * they name them, so no roster, streamed or polled, holds a value the user chose to hide, whatever
 * rows a browser holds when it lands. A row's tokens are its pane's, else its agent's, under its
 * pane's agent, else its agent record's (src/lib/sidebarAgents.ts, src/components/AgentSidebar.tsx).
 * The machines are copied where a value leaves, never changed: the manager keeps them.
 */
export function withoutHiddenTokens(layout: AgentRowTokens | null, machines: Machine[]): Machine[] {
  if (layout === null) return machines;
  return machines.map((machine) => {
    if (!machine.snapshot) return machine;
    const snapshot = snapshotWithoutHiddenTokens(layout, machine.snapshot);
    return snapshot === machine.snapshot ? machine : { ...machine, snapshot };
  });
}

/**
 * One PC's snapshot as a browser is told it, wherever it goes (#2160): the session read, the /ws
 * snapshot frame and the relayed or proxied ones, without the token values herdr's rows hide, as
 * withoutHiddenTokens tells the roster. Copied where a value leaves; the same object when none does.
 * Another Ovis server reading this PC with its bridge token gets the snapshot whole: it applies its
 * own rows, as herdr's sidebar is the client's config.
 */
export function snapshotWithoutHiddenTokens<S extends Pick<SessionSnapshot, "panes" | "agents">>(layout: AgentRowTokens | null, snapshot: S): S {
  if (layout === null) return snapshot;
  const recordAgent = new Map<string, string | null | undefined>();
  for (const record of snapshot.agents) if (!recordAgent.has(record.pane_id)) recordAgent.set(record.pane_id, record.agent);
  const paneAgent = new Map<string, string | null>();
  for (const pane of snapshot.panes) if (!paneAgent.has(pane.pane_id)) paneAgent.set(pane.pane_id, nonblank(pane.agent) ?? nonblank(recordAgent.get(pane.pane_id)));
  let changed = false;
  const shown = <T extends { pane_id: string; tokens?: Record<string, unknown> }>(item: T, agent: string | null): T => {
    const specs = paneTokenSpecs(layout, agent);
    if (!item.tokens || specs === null) return item;
    // the background tag files the row under the Agents list's background part: a rule may hide it from
    // the row (the browser applies the rows' rules too), never from the browser
    const kept = Object.entries(item.tokens).filter(([name, value]) => (name === ROLE_TOKEN && isBackgroundRole(value)) || !hiddenEverywhere(specs, name, value));
    if (kept.length === Object.keys(item.tokens).length) return item;
    changed = true;
    return { ...item, tokens: Object.fromEntries(kept) };
  };
  const panes = snapshot.panes.map((pane) => shown(pane, paneAgent.get(pane.pane_id) ?? null));
  const agents = snapshot.agents.map((record) => shown(record, paneAgent.has(record.pane_id) ? paneAgent.get(record.pane_id)! : nonblank(record.agent)));
  return changed ? { ...snapshot, panes, agents } : snapshot;
}

export function reportedTokenValues(machines: readonly Machine[]): Map<string, Set<string>> {
  const reported = new Map<string, Set<string>>();
  for (const { snapshot } of machines) {
    for (const { tokens } of [...snapshot?.panes ?? [], ...snapshot?.agents ?? []]) {
      for (const [name, value] of Object.entries(tokens ?? {})) {
        if (typeof value !== "string" || !value.trim()) continue;
        const values = reported.get(name) ?? new Set<string>();
        reported.set(name, values.add(value));
      }
    }
  }
  return reported;
}

/**
 * What browsers are told of the rows (#1349): the rows' tokens as they are, with the hide rules of
 * each place that has them decided here for the values reported (reportedTokenValues, of one roster
 * or of several): an `equals` rule that shows each such value the place draws, then one that hides
 * any other (`contains: ""` matches every value). The rules' own operands (a literal no pane
 * reports, a number's bound) stay on this PC, while a browser, an older one too, draws the same
 * tokens for those values (shared/pane-tokens.ts paneTokenValues). A value the server has not
 * decided, as one a browser kept from a roster told under other rows, is hidden there: a decision
 * that lands out of step with a roster can hide a value for a moment, never show one.
 */
export function decidedRowTokens(layout: AgentRowTokens | null, ...reported: ReadonlyMap<string, ReadonlySet<string>>[]): AgentRowTokens | null {
  if (layout === null) return null;
  const valuesOf = (name: string): string[] => [...new Set(reported.flatMap((values) => [...values.get(name) ?? []]))];
  const decide = (specs: PaneTokenSpec[]): PaneTokenSpec[] => specs.map(({ name, rules }) => {
    if (rules === undefined) return { name };
    const shown = valuesOf(name).filter((value) => !rules.find((rule) => paneTokenRuleMatches(rule, value))?.hide).sort();
    return { name, rules: [...shown.map((value): PaneTokenRule => ({ equals: value })), { contains: "", hide: true }] };
  });
  return { rows: layout.rows && decide(layout.rows), by_agent: Object.fromEntries(Object.entries(layout.by_agent).map(([agent, specs]) => [agent, decide(specs)])) };
}

/**
 * herdr's sidebar rows for agents, read from its config.toml, and read again when the file
 * changes while a browser listens (herdr's own sidebar reads them at start and on reload-config).
 */
export class HerdrSidebarConfig {
  private stamp: string | null | undefined;
  private layout: AgentRowTokens | null = null;
  private readonly listeners = new Set<(layout: AgentRowTokens | null) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly path = herdrConfigPath(), private readonly pollMs = POLL_MS) {}

  get(): AgentRowTokens | null {
    this.refresh();
    return this.layout;
  }

  subscribe(listener: (layout: AgentRowTokens | null) => void): () => void {
    this.listeners.add(listener);
    if (this.timer === null) {
      this.timer = setInterval(() => this.refresh(), this.pollMs);
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0 || this.timer === null) return;
      clearInterval(this.timer);
      this.timer = null;
    };
  }

  private refresh(): void {
    if (!this.read()) return;
    for (const told of [...this.listeners]) told(this.layout);
  }

  private read(): boolean {
    let stamp: string | null;
    try {
      const stat = statSync(this.path);
      stamp = stat.isFile() && stat.size <= MAX_CONFIG_BYTES ? `${stat.mtimeMs}:${stat.size}` : null;
    } catch { stamp = null; }
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    let next: AgentRowTokens | null = null;
    if (stamp !== null) {
      const parsed = readHerdrConfig(this.path);
      try { next = parsed === null ? null : agentRowTokens(parsed); } catch { next = null; }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.layout);
    this.layout = next;
    return changed;
  }
}
