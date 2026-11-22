import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ci.yml runs on pushes to main (windows-install.yml has no push trigger). Pushes to main share one group, as in
// oh-my-openagent's ci.yml: a running push run is never cancelled, and a newer push cancels the one still waiting,
// so the newest run covers the merges in between. A manual run (or a caller's, through workflow_dispatch) has a
// group of its own, so it never replaces a waiting push run that Pages deploys from. A pull request keeps one group
// per branch (per caller workflow) and cancels its superseded run.
type Workflow = { on: { push?: { branches?: string[] } }; concurrency: { group: string; "cancel-in-progress": string } };
const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as Workflow;

it("keeps main's running push run and its newest waiting one, and groups a pull request by its branch", () => {
  expect(ci.on.push?.branches).toContain("main");
  expect(ci.concurrency).toEqual({
    group: "validation-${{ github.workflow }}-${{ github.ref }}${{ github.event_name == 'workflow_dispatch' && '-manual' || '' }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});
