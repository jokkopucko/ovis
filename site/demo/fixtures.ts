import type { ConversationTurn, InteractivePrompt, SessionHistoryAgent, SessionHistoryRow, SlashCommand } from "../../shared/protocol.ts";
import { AGENT_CATALOG, catalogRow, meetsMinVersion, type AgentCatalogResponse } from "../../shared/agent-catalog.ts";

export interface DemoSpec {
  key: string;
  label: string;
  title: string;
  agent: string | null;
  state?: "idle" | "working" | "blocked";
  worktreeOf?: string;
  branch?: string;
  tabOf?: string;
}

const DEMO_INSTALLED: Readonly<Record<string, string>> = { claude: "2.1.311", codex: "0.163.0", omp: "18.8.7", pi: "0.73.1", hermes: "0.22.5" };

export const DEMO_AGENT_CATALOG: AgentCatalogResponse = {
  platform: "linux",
  agents: AGENT_CATALOG.map((entry) => {
    const version = DEMO_INSTALLED[entry.id];
    return catalogRow(entry, "linux", version === undefined
      ? { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null }
      : { installed: true, binary: entry.detect.binaries[0]!, on_path: true, version, version_error: null, meets_min_version: entry.min_version === null ? null : meetsMinVersion(version, entry.min_version.version) });
  }),
};

export const SPECS: DemoSpec[] = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "export-guard", title: "Guard the export button", agent: "codex", state: "blocked", worktreeOf: "api", branch: "feat/export-guard" },
  { key: "flaky", label: "flaky-retry-test", title: "Fix the flaky retry test", agent: "claude", state: "idle", worktreeOf: "api", branch: "fix/flaky-retry-test" },
  { key: "omp", label: "cli-tools", title: "Plan the config file", agent: "omp", state: "idle" },
  { key: "cli", label: "retry-flag", title: "Ship the retry flag", agent: "pi", state: "idle", worktreeOf: "omp", branch: "feat/retry-flag" },
  { key: "hermes", label: "changelog", title: "Draft the changelog", agent: "hermes", state: "idle", worktreeOf: "omp", branch: "docs/changelog" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null, tabOf: "api" },
];

export const t = (min: number, sec = 0) => `2026-09-25T09:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;

const RESUME_FLAGS: Record<SessionHistoryAgent, string[]> = {
  claude: ["--resume"], codex: ["resume"], pi: ["--session"], omp: ["--resume"], gjc: ["--resume"], cmd: ["--session"],
  omo: ["--session-id"], opencode: ["--session"], hermes: ["--resume"], grok: ["--resume"], agy: ["--conversation"], devin: ["--resume"],
};
export const SESSION_HISTORY_AGENTS = Object.keys(RESUME_FLAGS) as SessionHistoryAgent[];

/**
 * The session a launch's arguments resume: the agent's own resume flags, then the id, as its history
 * rows give them (`claude --resume <id>`, `codex resume <id>`); any other arguments resume none.
 */
export function resumedSession(agent: string | null, args: unknown): string | null {
  if (agent === null || !(SESSION_HISTORY_AGENTS as string[]).includes(agent) || !Array.isArray(args)) return null;
  const flags = RESUME_FLAGS[agent as SessionHistoryAgent];
  const id: unknown = args[flags.length];
  return args.length === flags.length + 1 && flags.every((flag, index) => args[index] === flag) && typeof id === "string" ? id : null;
}

export const DEMO_PUSH = {
  publicKey: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
  retired: {
    subscription: { endpoint: "https://push.example.test/demo/retired", keys: { p256dh: "CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYar0PUaP2SJrtP4HUJnjLHW-yBFao-02f4jSG2St9wBJks", auth: "BzxxptsQRXqv5BlOg7jtIg" } },
    status: { registered: false, last_success_at: t(2), last_failure_at: t(41), last_failure: "gone" as const },
  },
  refused: {
    subscription: { endpoint: "https://push.example.test/demo/refused", keys: { p256dh: "AyA9WneUsc7rCCVCX3yZttPwDSpHZIGeu9j1Ei9MaYajwN36FzRRbouoxeL_HDlWc5CtyucEIT5beJWyz-wJJkM", auth: "BUJ_vPk2c7DtKmek4R5bmA" } },
    status: { registered: true, last_success_at: t(2), last_failure_at: t(44), last_failure: "rejected" as const },
  },
};

export function sessionHistoryRows(agent: SessionHistoryAgent): SessionHistoryRow[] {
  const row = (id: string, title: string, firstMessage: string, started: number, updated: number): SessionHistoryRow =>
    ({ id, title, firstMessage, startedAt: t(started), updatedAt: t(updated), resume: { argv: [agent, ...RESUME_FLAGS[agent], id] } });
  return [
    row(`demo-${agent}-0002`, "Retry budget for the payment client", "Cap the payment client's retries at three and log each one.", 4, 9),
    row(`demo-${agent}-0001`, "Flaky export test", "Why does the export test fail one run in ten?", 0, 3),
  ];
}
/**
 * The skills an agent would offer in a demo folder before any pane runs it (GET /api/agent/commands):
 * Codex types its skills as `$name`, the others as `/name`; a project skill and one of the user's own
 * for each, so the new workspace and tab dialogs show both.
 */
export function agentSkillRows(agent: string): SlashCommand[] {
  const skill = (name: string, description: string, origin: "user" | "project"): SlashCommand => ({
    name, description, source: "skill", origin, ...(agent === "codex" ? { trigger: "$" as const } : {}),
    forms: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "unknown" }],
    visibility: "offered", provenance: { transport: "scan", verified: false }, id: `/home/demo/${origin === "project" ? "checkout-api/.agents" : ".agents"}/skills/${name}/SKILL.md`,
  });
  switch (agent) {
    case "codex":
      return [skill("review-pr", "Review the branch against main and list the findings", "project"), skill("release-notes", "Draft release notes from the merged pull requests", "user"), skill("flaky-tests", "Find and fix a flaky test by its history", "user")];
    case "claude":
      return [skill("review-pr", "Review the branch against main and list the findings", "project"), skill("changelog", "Write the changelog fragment for a change", "user")];
    case "omp":
    case "pi":
      return [skill("plan-config", "Plan a config file's keys before writing it", "project")];
    default:
      return [];
  }
}

const tool = (name: string, summary: string, input: unknown, output: string): ConversationTurn["parts"][number] => ({ kind: "tool", name, summary, input: typeof input === "string" ? input : JSON.stringify(input, null, 2), output });

export const CHATS: Record<string, { turns: ConversationTurn[]; metadata: { model: string; reasoning_effort: string } }> = {
  api: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(2), parts: [{ kind: "text" as const, text: "Make `POST /payments` idempotent: a client retrying with the same `Idempotency-Key` must get the first response back, never a second charge. Cover it with tests." }] },
      { role: "assistant" as const, ts: t(2, 5), end_ts: t(4, 41), parts: [
        { kind: "text" as const, text: "I'll look at how payments are created and where a key could be stored." },
        tool("Grep", "Idempotency-Key", { pattern: "Idempotency-Key", path: "src" }, "src/routes/payments.ts:14: // TODO: honour Idempotency-Key"),
        tool("Read", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "export async function createPayment(req: Request) { … }"),
        tool("Edit", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "Updated src/routes/payments.ts"),
        tool("Write", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Created src/lib/idempotency.ts"),
        tool("Bash", "bun test payments", { command: "bun test payments" }, " 14 pass\n 0 fail\nRan 14 tests across 2 files. [412ms]"),
        { kind: "text" as const, text: "Done. Retries are now safe:\n\n- **`src/lib/idempotency.ts`** stores the first response per key for 24 h, scoped to the API client, so two clients can reuse a key without colliding.\n- **`POST /payments`** replays the stored response for a repeated key, and answers `409` while the first request with that key is still in flight.\n- A repeated key with a **different body** is rejected with `422`, instead of silently returning the old payment.\n\n```ts\nconst cached = await idempotency.lookup(client.id, key, body);\nif (cached) return cached.response;\n```\n\nTests: 14 pass, including concurrent retries and a key reused with a changed amount. See https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ for the header's semantics." },
      ] },
      { role: "user" as const, ts: t(6), parts: [{ kind: "text" as const, text: "Nice. Now add a metric for replayed requests." }] },
      { role: "assistant" as const, ts: t(6, 3), parts: [
        { kind: "text" as const, text: "Adding a `payments_idempotent_replays_total` counter next to the existing request metrics." },
        tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"),
        tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"),
      ] },
    ],
  },
  web: {
    metadata: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    turns: [
      { role: "user" as const, ts: t(1), parts: [{ kind: "text" as const, text: "Rate-limit the export button so a double click can't start two exports, then push the branch." }] },
      { role: "assistant" as const, ts: t(1, 4), end_ts: t(3, 20), parts: [
        tool("update_plan", "update_plan", { plan: [{ step: "Find where the export starts", status: "in_progress" }, { step: "Guard the button while an export runs", status: "pending" }, { step: "Push the branch", status: "pending" }] }, "Plan updated"),
        tool("update_plan", "update_plan", { plan: [{ step: "Find where the export starts", status: "completed" }, { step: "Guard the button while an export runs", status: "in_progress" }, { step: "Push the branch", status: "pending" }] }, "Plan updated"),
        tool("exec", "rg -n \"startExport\" src", { cmd: "rg -n \"startExport\" src" }, "src/pages/Reports.tsx:88:  onClick={() => startExport(filters)}"),
        tool("apply_patch", "src/pages/Reports.tsx", "*** Begin Patch\n*** Update File: src/pages/Reports.tsx\n@@\n-  onClick={() => startExport(filters)}\n+  disabled={exporting}\n+  onClick={() => { if (!exporting) startExport(filters); }}\n*** End Patch", "Success. Updated the following files:\nM src/pages/Reports.tsx"),
        tool("exec", "pnpm test --filter reports", { cmd: "pnpm test --filter reports" }, "✓ 9 tests passed"),
        { kind: "text" as const, text: "The button is disabled while an export runs, and a second click within the same run is ignored. Tests pass; I need your OK to push `feat/export-guard`." },
      ] },
    ],
  },
  flaky: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(7), parts: [{ kind: "text" as const, text: "`retries a timed-out upload` fails about one run in ten. Find out why and fix it." }] },
      { role: "assistant" as const, ts: t(7, 4), end_ts: t(9, 30), parts: [
        tool("TodoWrite", "TodoWrite", { todos: [{ content: "Reproduce the failure", status: "in_progress", activeForm: "Reproducing the failure" }, { content: "Find what the timing depends on", status: "pending", activeForm: "Finding what the timing depends on" }, { content: "Fix the test and rerun it 50 times", status: "pending", activeForm: "Fixing the test" }] }, "Todos have been modified successfully."),
        tool("TodoWrite", "TodoWrite", { todos: [{ content: "Reproduce the failure", status: "completed", activeForm: "Reproducing the failure" }, { content: "Find what the timing depends on", status: "in_progress", activeForm: "Finding what the timing depends on" }, { content: "Fix the test and rerun it 50 times", status: "pending", activeForm: "Fixing the test" }] }, "Todos have been modified successfully."),
        tool("Read", "src/lib/retry.test.ts", { file_path: "src/lib/retry.test.ts" }, "test(\"retries a timed-out upload\", async () => { … })"),
        tool("Bash", "bun test retry --rerun-each 50", { command: "bun test retry --rerun-each 50" }, " 46 pass\n 4 fail\nexpected 3 attempts, received 2"),
        tool("Edit", "src/lib/retry.test.ts", { file_path: "src/lib/retry.test.ts" }, "Updated src/lib/retry.test.ts"),
        tool("Bash", "bun test retry --rerun-each 50", { command: "bun test retry --rerun-each 50" }, " 50 pass\n 0 fail"),
        { kind: "text" as const, text: "The test waited on the real clock, so a slow run let the backoff timer fire before the second attempt was counted. It now drives the timer with a fake clock: 50 runs out of 50 pass." },
      ] },
    ],
  },
  omp: {
    metadata: { model: "anthropic/claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(3), parts: [{ kind: "text" as const, text: "Plan a `cli-tools.toml` so the flags people repeat can live in a file." }] },
      { role: "assistant" as const, ts: t(3, 4), end_ts: t(5, 10), parts: [
        tool("todo", "todo", { op: "init", list: [{ phase: "Plan", items: ["Read the flags people repeat", "Pick where the file is read from", "Write the plan"] }] }, "Overall: 0/3 done, 3 open.\n  Plan:\n    - [ ] Read the flags people repeat (in progress)\n    - [ ] Pick where the file is read from\n    - [ ] Write the plan"),
        tool("todo", "todo", { op: "done", task: "Read the flags people repeat" }, "Overall: 1/3 done, 2 open.\n  Plan:\n    - [X] Read the flags people repeat\n    - [ ] Pick where the file is read from (in progress)\n    - [ ] Write the plan"),
        tool("bash", "rg -n \"option\\(\" src/cli.ts", { command: "rg -n \"option\\(\" src/cli.ts" }, "src/cli.ts:12:  .option(\"--retries <n>\")\nsrc/cli.ts:13:  .option(\"--registry <url>\")\nsrc/cli.ts:14:  .option(\"--dry-run\")"),
        { kind: "text" as const, text: "Three steps:\n\n1. Read `cli-tools.toml` from the project root, then `~/.config/cli-tools.toml`.\n2. A flag on the command line wins over the file, the file over the defaults.\n3. `cli-tools config` prints the merged values and where each one came from.\n\n`--retries` and `--registry` move over as they are; `--dry-run` stays a flag only." },
      ] },
    ],
  },
  hermes: {
    metadata: { model: "hermes-4-405b", reasoning_effort: "medium" },
    turns: [
      { role: "user" as const, ts: t(14), parts: [{ kind: "text" as const, text: "Draft the changelog for 2.0 from the merged pull requests." }] },
      { role: "assistant" as const, ts: t(14, 3), end_ts: t(15, 20), parts: [
        tool("terminal", "gh pr list --state merged --base main", { command: "gh pr list --state merged --base main" }, "#48  feat: retry flaky uploads\n#51  feat: read cli-tools.toml\n#53  fix: exit 2 on a bad flag"),
        { kind: "text" as const, text: "## 2.0\n\n### Added\n- `--retries` retries a failed upload, never a rejected one (#48).\n- Flags can live in `cli-tools.toml` (#51).\n\n### Fixed\n- A bad flag exits with code 2 instead of 1 (#53)." },
      ] },
    ],
  },
  // pi reads its own session file, which is an entry tree rather than a log: a `/tree` move
  // shows only the branch in play, and a `/compact` leaves a summary where it folded the rest.
  cli: {
    metadata: { model: "anthropic/claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(11), parts: [{ kind: "text" as const, text: "`release publish` dies on a flaky upload. Retry it, but never on a 4xx." }] },
      { role: "assistant" as const, ts: t(11, 4), end_ts: t(13, 12), parts: [
        { kind: "thinking" as const, text: "A 4xx means the request itself is wrong, so retrying only wastes another upload. The retry belongs around the transport error, not around the call." },
        { kind: "text" as const, text: "I'll find where the upload is issued before wrapping anything." },
        tool("bash", "rg -n upload src/publish", { command: "rg -n upload src/publish" }, "src/publish.ts:41:  const res = await upload(archive);"),
        tool("edit", "src/publish.ts", { path: "src/publish.ts" }, "Updated src/publish.ts"),
        tool("bash", "bun test publish", { command: "bun test publish" }, " 11 pass\n 0 fail\nRan 11 tests across 1 file. [286ms]"),
        { kind: "text" as const, text: "`upload` now retries a transport failure three times with backoff, and a 4xx fails on the first answer. Added `--retries`, defaulting to 3." },
      ] },
      { role: "user" as const, ts: t(20), parts: [{ kind: "compact" as const, text: "## Session Goal\n- Add bounded retries to `release publish` without retrying a 4xx\n\n## Files And Changes\n- `src/publish.ts` — `upload(archive, { retries })`, transport errors only\n- `src/publish.test.ts` — 11 tests, one per status family\n\n## User Preferences\n- Never retry a request the server rejected on purpose" }] },
      { role: "user" as const, ts: t(21), parts: [{ kind: "text" as const, text: "Now expose it as `RELEASE_RETRIES`." }] },
      { role: "assistant" as const, ts: t(21, 3), end_ts: t(22, 40), parts: [
        tool("read", "src/config.ts", { path: "src/config.ts" }, "export interface PublishOptions { … }"),
        tool("edit", "src/config.ts", { path: "src/config.ts" }, "Updated src/config.ts"),
        { kind: "text" as const, text: "`RELEASE_RETRIES` sets the default, and `--retries` still wins over it. The README's environment table lists it." },
      ] },
    ],
  },
};

/**
 * Claude Code and Codex record each call's own id (shared/protocol.ts `call_id`); every call in
 * these chats was answered. Claude's unflagged tool_result makes it `ok`; Codex records no outcome,
 * so its answered calls carry no state. Other agents' chats carry neither.
 */
for (const [key, agent] of [["api", "claude"], ["flaky", "claude"], ["web", "codex"]] as const) {
  let n = 0;
  for (const turn of CHATS[key]!.turns) for (const part of turn.parts) {
    if (part.kind !== "tool") continue;
    n += 1;
    part.call_id = agent === "claude" ? `toolu_demo_${key}_${n}` : `call_demo_${key}_${n}`;
    if (agent === "claude") part.state = "ok";
  }
}

export const PROMPT: InteractivePrompt = {
  id: "demo-approval",
  agent: "codex",
  kind: "approval" as const,
  // the shape Codex's approval has on the wire: the heading is the question too, and the command
  // is the body (server/prompt.ts)
  title: "Allow command?",
  question: "Allow command?",
  body: "git push origin feat/export-guard",
  options: [
    { label: "Yes", description: null },
    { label: "Yes, and don't ask again for git push", description: null },
    { label: "No, and tell Codex what to do differently", description: null },
  ],
  multi_select: false,
  custom_option_index: null,
};
