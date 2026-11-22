import { describe, expect, test } from "bun:test";
import { readers } from "./index.ts";
import { readersFor, type DialogReader, type ReaderContext } from "./registry.ts";
import { onePerPass } from "./shared.ts";

const snapshot: Record<string, readonly [DialogReader["reread"], DialogReader["list"]]> = {
  "claude-question": ["none", "none"],
  "claude-submit": ["none", "none"],
  "claude-approval": ["none", "none"],
  "claude-plan": ["none", "none"],
  "claude-confirm": ["before-commit", "none"],
  "claude-model": ["before-commit", "letter-window"],
  "claude-effort": ["before-commit", "slider"],
  "claude-held": ["none", "none"],
  "claude-goal": ["before-commit", "none"],
  "codex-menu": ["none", "none"],
  "codex-question": ["none", "none"],
  "codex-async-question": ["none", "none"],
  "codex-approval": ["none", "none"],
  "codex-model": ["before-commit", "letter-window"],
  "letta-model": ["before-commit", "letter-window"],
  "letta-effort": ["before-commit", "none"],
  "omp-question": ["none", "none"],
  "omp-submit": ["none", "none"],
  "omp-approval": ["none", "none"],
  "omp-model": ["each-move", "none"],
  "omp-handoff": ["before-commit", "none"],
  "omo-model": ["before-commit", "none"],
  "omo-question": ["before-commit", "none"],
  "omo-typing": ["none", "none"],
  "omo-review": ["none", "none"],
  "omo-pending": ["none", "none"],
  "pi-model": ["before-commit", "none"],
  "pi-thinking": ["before-commit", "none"],
  "pi-questionnaire-question": ["each-move", "none"],
  "pi-questionnaire-submit": ["each-move", "none"],
  "pi-ask-question": ["before-commit", "none"],
  "pi-ask-submit": ["before-commit", "none"],
  "pi-ask-user": ["before-commit", "none"],
  "pi-question": ["none", "none"],
  "pi-confirm": ["none", "none"],
  "pi-input": ["none", "none"],
  "hermes-question": ["none", "none"],
  "hermes-input": ["none", "none"],
  "hermes-approval": ["none", "none"],
  "agy-question": ["none", "none"],
  "dsh-question": ["before-commit", "none"],
  "cmd-question": ["before-commit", "none"],
  "opencode-question": ["before-commit", "none"],
  "opencode-v1-question": ["none", "none"],
  "hermes-help": ["none", "none"],
  "hermes-status": ["none", "none"],
  "hermes-version": ["none", "none"],
  "hermes-profile": ["none", "none"],
  "hermes-reload-skills": ["none", "none"],
  "fallback-menu": ["none", "none"],
  "fallback-gjc-menu": ["before-commit", "none"],
  "fallback-keys": ["none", "none"],
};

describe("dialog reader behavior snapshot", () => {
  test("registers every snapshot reader once", () => {
    const ids = readers.map((reader) => reader.id).sort();
    expect(ids).toEqual(Object.keys(snapshot).sort());
  });

  for (const reader of readers) {
    test(`preserves ${reader.id} reread and list behavior`, () => {
      expect(snapshot[reader.id]?.[0]).toBe(reader.reread);
      expect(snapshot[reader.id]?.[1]).toBe(reader.list);
    });
  }
});

test("keeps OmO cross-listing after each agent's own readers", () => {
  const omo = ["omo-model", "omo-question", "omo-typing", "omo-review", "omo-pending"];
  for (const agent of ["omo", "pi", "claude", ""]) {
    const ids = readersFor(agent).map((reader) => reader.id);
    expect(ids.filter((id) => id.startsWith("omo-"))).toEqual(omo);
    if (agent === "pi") expect(ids.indexOf("omo-model")).toBeLessThan(ids.indexOf("pi-question"));
    if (agent === "claude") expect(ids.indexOf("claude-held")).toBeLessThan(ids.indexOf("omo-model"));
  }
});

test("keeps fallback readers last for known and unknown agents", () => {
  for (const agent of ["claude", "codex", "omp", "omo", "pi", "hermes", "gjc", "opencode", "grok", "agy", "devin", "cmd", "dsh-tui", "", "unknown"]) {
    expect(readersFor(agent).slice(-3).map((reader) => reader.id)).toEqual(["fallback-menu", "fallback-gjc-menu", "fallback-keys"]);
  }
});

const order: Record<string, readonly string[]> = {
  "": ["omo-model", "omo-question", "omo-typing", "omo-review", "omo-pending", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  agy: ["agy-question", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  claude: ["claude-goal", "claude-question", "claude-submit", "claude-approval", "claude-plan", "claude-confirm", "claude-model", "claude-effort", "claude-held", "omo-model", "omo-question", "omo-typing", "omo-review", "omo-pending", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  cmd: ["cmd-question", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  "dsh-tui": ["dsh-question", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  codex: ["codex-menu", "codex-question", "codex-async-question", "codex-approval", "codex-model", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  letta: ["letta-model", "letta-effort", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  hermes: ["hermes-question", "hermes-input", "hermes-approval", "hermes-status", "hermes-version", "hermes-profile", "hermes-reload-skills", "hermes-help", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  omo: ["omo-model", "omo-question", "omo-typing", "omo-review", "omo-pending", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  omp: ["omp-question", "omp-submit", "omp-approval", "omp-model", "omp-handoff", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  opencode: ["opencode-question", "opencode-v1-question", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
  pi: ["pi-thinking", "pi-model", "omo-model", "pi-questionnaire-question", "pi-questionnaire-submit", "pi-ask-question", "pi-ask-submit", "pi-ask-user", "pi-question", "pi-confirm", "pi-input", "omo-question", "omo-typing", "omo-review", "omo-pending", "fallback-menu", "fallback-gjc-menu", "fallback-keys"],
};

describe("dialog reader order", () => {
  test("covers every agent a reader names", () => {
    const agents = [...new Set(readers.flatMap((reader) => reader.agents))].filter((agent) => agent !== "*").sort();
    expect(agents).toEqual(Object.keys(order).sort());
  });

  for (const [agent, ids] of Object.entries(order)) {
    test(`offers ${agent || "an unnamed agent"}'s screen to its readers in a fixed order`, () => {
      expect(readersFor(agent).map((reader) => reader.id)).toEqual([...ids]);
    });
  }
});

test("a parser several readers share runs once per screen and read pass", () => {
  let runs = 0;
  const read = onePerPass((screen) => { runs += 1; return screen.length; });
  const pass = (): ReaderContext => ({ agent: "claude", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false });
  const first = pass();
  expect([read("menu", first), read("menu", first), read("menu", first)]).toEqual([4, 4, 4]);
  expect(runs).toBe(1);
  read("other", first);
  expect(runs).toBe(2);
  read("other", pass());
  expect(runs, "a new read pass parses again").toBe(3);
});
