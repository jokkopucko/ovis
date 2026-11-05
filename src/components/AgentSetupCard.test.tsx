import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AGENT_CATALOG, catalogRow } from "../../shared/agent-catalog.ts";
import type { SetupStep } from "../lib/agentSetup.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentSetupCard } from "./AgentSetupCard.tsx";

const row = (id: string) => catalogRow(AGENT_CATALOG.find((entry) => entry.id === id)!, "linux", { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
const tab = { pane_id: "w1:p2", workspace_id: "w1", command: "curl -fsSL https://claude.ai/install.sh | bash", shell: "posix" as const };
const render = (initial: SetupStep, id = "claude"): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(<SettingsProvider><AgentSetupCard agent={row(id)} initial={initial} onOpenTerminal={() => {}} onStart={() => {}} /></SettingsProvider>);
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
/** The step the card shows (its status line's state) and where each step marker stands. */
const states = (html: string) => ({
  status: /class="agent-setup-status"[^>]*data-state="([^"]+)"/.exec(html)?.[1],
  steps: [...html.matchAll(/<li(?: data-state="([^"]+)")?>/g)].map((match) => match[1] ?? "next"),
});
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g)].map((match) => match[1]);

describe("AgentSetupCard", () => {
  it("offers Install for an agent with a command, and none for one without", () => {
    expect(buttons(render({ kind: "idle" }))).toEqual(["Install", "Show details"]);
    expect(render({ kind: "idle" }, "muse")).toMatch(/<button[^>]*disabled=""[^>]*>Install<\/button>/);
  });

  it("shows each step's state and only that step's actions", () => {
    const installing = render({ kind: "installing", tab });
    expect(states(installing)).toEqual({ status: "installing", steps: ["now", "next"] });
    expect(buttons(installing)).toEqual(["Show details", "Open terminal", "Cancel"]);
    const notOnPath = render({ kind: "installed", version: "2.1.312", onPath: false });
    expect(states(notOnPath)).toEqual({ status: "installed", steps: ["done", "now"] });
    // what PATH means stays under Show details, closed until asked for
    expect(notOnPath).not.toContain("agent-setup-note");
    expect(buttons(notOnPath)).toEqual(["Sign in", "Skip", "Show details"]);
    expect(buttons(render({ kind: "installed", version: "2.1.312", onPath: true }))).toEqual(["Sign in", "Skip", "Show details"]);
    expect(states(render({ kind: "failed", message: "fixture failure", after: "install" }))).toEqual({ status: "failed", steps: ["failed", "next"] });
    // there but not running: installed again from the same card
    const broken = render({ kind: "failed", message: null, after: "install" });
    expect(states(broken)).toEqual({ status: "failed", steps: ["failed", "next"] });
    expect(buttons(broken)).toEqual(["Try again", "Show details", "Cancel"]);
    expect(buttons(render({ kind: "ready", version: "2.1.312" }))).toEqual(["Start Claude Code"]);
    expect(buttons(render({ kind: "failed", message: "fixture failure", after: "install" }))).toEqual(["Try again", "Show details", "Cancel"]);
  });
});
