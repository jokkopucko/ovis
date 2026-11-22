// The one command of this check. See SKILL.md.
//   bun .claude/skills/verify-turn-gate/check.ts            every run, each against what it must say
//   bun .claude/skills/verify-turn-gate/check.ts <name>     one run, with its path when a rule breaks
import { cleanup, type Config, explore, type Result, type Rule, RULES, VARIANTS } from "./explore.ts";

// The agent and herdr as SKILL.md describes them ("What the check assumes"): each `false` below is a thing the real
// system can do, left out because a rule breaks with it. The finding-* and limit-* runs put them back one at a time.
// A Send now past a turn's end, a second Send now during a Codex restart, a reconcile's baseline and a queue send typed
// at once behind an open wait were such findings (#4118): the gate meets them now, and every run asks with them.
const described = { free: false, rest: "idle" as const, overtake: false, lateEvents: false, steerPastEnd: true, sendNowDuringRestart: true, baseline: true, atOnce: true, slowEnter: false, ownQueue: false, others: 0 };
const all: Rule[] = [...RULES];
const gate: Rule[] = ["QueueWaitsForTurnEvidence"];
const turn: Rule[] = ["NoAutomaticEnterIntoQueuedTurn"];
const small = { ...described, messages: 3, owners: ["a"], blocks: 0, gone: false, moves: false, holds: false };
const broken = (variant: string, rule: Rule, more: Partial<Config> = {}): Config => ({ ...small, name: `broken-${variant}`, agent: "codex", variant, rules: [rule], expect: rule, ...more });
export const CONFIGS: Config[] = [
  // the class and its callers, whatever statuses come and whatever the reads say
  { ...described, free: true, name: "gate", agent: "codex", messages: 3, owners: ["a"], blocks: 0, gone: true, moves: false, holds: true, rules: gate, expect: "holds" },
  { ...described, free: true, rest: "done", name: "gate-two-pages", agent: "codex", messages: 2, owners: ["a", "b"], blocks: 0, gone: true, moves: true, holds: true, rules: gate, expect: "holds" },
  // with the agent and herdr described
  { ...described, name: "turns-claude", agent: "claude", messages: 3, owners: ["a"], blocks: 1, gone: true, moves: false, holds: true, rules: all, expect: "holds" },
  { ...described, rest: "done", name: "turns-codex", agent: "codex", messages: 2, owners: ["a"], blocks: 1, gone: true, moves: false, holds: true, rules: all, expect: "holds" },
  { ...described, name: "turns-moved", agent: "codex", messages: 2, owners: ["a", "b"], blocks: 0, gone: false, moves: true, holds: true, rules: all, expect: "holds" },
  // a snapshot ahead of status events that shows the status the queue already has can open the queue early, yet no Enter
  // of the queue's follows into the turn
  { ...described, overtake: true, rest: "done", name: "turns-ahead", agent: "codex", messages: 2, owners: ["a"], blocks: 1, gone: false, moves: false, holds: false, rules: turn, expect: "holds" },
  // each rule can fail: a broken copy of the class
  broken("claim-replaces-wait", "QueueWaitsForTurnEvidence", { free: true }),
  broken("sent-ends-wait", "QueueWaitsForTurnEvidence", { free: true }),
  broken("timeout-without-hold", "QueueWaitsForTurnEvidence", { free: true }),
  broken("deadline-at-once", "QueueWaitsForTurnEvidence", { free: true }),
  broken("restart-counts-old-working", "QueueWaitsForTurnEvidence", { free: true }),
  broken("observe-ignores-mark", "QueueWaitsForTurnEvidence", { free: true }),
  broken("ready-without-working", "NoAutomaticEnterIntoQueuedTurn"),
  // what the code does today: see SKILL.md, "What it has found"
  { ...small, name: "finding-late-status-events", agent: "claude", overtake: true, lateEvents: true, rules: turn, expect: "NoAutomaticEnterIntoQueuedTurn" },
  // what status evidence cannot tell: see SKILL.md, "What the check assumes"
  { ...small, name: "limit-slow-enter", agent: "claude", slowEnter: true, rules: turn, expect: "NoAutomaticEnterIntoQueuedTurn" },
  { ...small, name: "limit-own-queue", agent: "claude", ownQueue: true, rules: turn, expect: "NoAutomaticEnterIntoQueuedTurn" },
  // a turn something else starts broke the rule only through a Send now whose steering wait that turn's end completed:
  // since #4118 such a ready waits for the Send now's own turn, and the run holds
  { ...small, name: "turns-other-turn", agent: "claude", others: 1, rules: turn, expect: "holds" },
];

function print(result: Result): void {
  const { config, broken: path } = result;
  console.log(`\n${config.name}: ${path ? `${path.rule} breaks` : "every rule holds"} (${result.states} states, ${(result.ms / 1000).toFixed(1)} s)`);
  if (config.variant) console.log(`  the break: ${VARIANTS[config.variant]!.what}`);
  if (!path) return;
  path.steps.forEach((step, at) => console.log(`  ${String(at + 1).padStart(2)}. ${step.label}\n        ${step.after}`));
}

const only = process.argv[2];
const runs = only ? CONFIGS.filter((config) => config.name === only) : CONFIGS;
if (runs.length === 0) { console.error(`no run named ${only}. Runs: ${CONFIGS.map((config) => config.name).join(", ")}`); process.exit(2); }
let wrong = 0;
try {
  for (const config of runs) {
    const result = await explore(config);
    const said = result.broken ? result.broken.rule : "holds";
    const ok = said === config.expect;
    if (!ok) wrong++;
    if (only || !ok) print(result);
    else console.log(`ok    ${config.name}: ${said === "holds" ? "every rule holds" : `${said} breaks, as it must`} (${result.states} states, ${(result.ms / 1000).toFixed(1)} s)`);
    if (!ok) console.log(`  WRONG: this run must say "${config.expect}"${config.via ? `, by a path with the steps ${config.via.map((step) => `"${step}"`).join(", then ")} (${result.passed} breaks without them were passed over)` : ""}`);
  }
} finally { cleanup(); }
process.exit(wrong === 0 ? 0 : 1);
