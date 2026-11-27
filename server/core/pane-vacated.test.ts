import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ApprovalHub } from "../approvals/hub.ts";
import { ompApprovals } from "../approvals/omp.ts";
import { relay, relayOptions } from "../approvals/relay.ts";
import { handlers, hub, root } from "./status.fake.ts";

// the adversarial review of #4480: a Claude's hook requests were held under the pane ID it was started in, which herdr
// moves and reuses (server/approvals/hub.ts forget)
describe("a pane that leaves its ID", () => {
  it.each([
    ["ends", () => handlers.onPaneEnded("w1:p1")],
    ["closes", () => handlers.onPaneClosed("w1:p1")],
    ["moves to another workspace", () => handlers.onPaneMoved("w1:p1", "w2:p1")],
  ] as const)("says so when it %s", (_label, away) => {
    const vacated: string[] = [];
    hub(undefined, undefined, undefined, undefined, undefined, { paneVacated: (paneId) => vacated.push(paneId) });
    away();
    expect(vacated).toEqual(["w1:p1"]);
  });
});

describe.skipIf(process.platform === "win32")("a context-reporting launch in a pane that stays open", () => {
  it.each(["shell status event", "different agent snapshot"])("does not give a manual replacement the old reading after a %s", async (departure) => {
    const approvals = new ApprovalHub(mkdtempSync(join(root, "c-")), [{ ...ompApprovals, launchArgs: (_args, hook) => hook.args }]);
    const h = hub(undefined, undefined, undefined, undefined, undefined, {
      hookContextOf: (paneId, kind) => approvals.contextOf(paneId, kind),
      observeHookAgent: (paneId, kind) => approvals.observeContextAgent(paneId, kind),
    });
    const paneId = "w1:p1";
    const base = { pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle" };
    const session = (value: string) => ({ ...base, agent: "omp", agent_session: { agent: "omp", source: "herdr:omp", kind: "id", value } });
    const show = async (pane: unknown) => { h.herdrSays(pane); return (await h.snapshot()).panes[0]; };
    try {
      const hook = relayOptions(approvals.launchArgs("omp", paneId, [], "18.14.0") ?? []);
      if (hook === null) throw new Error("omp launch did not get a hook");
      const key = readFileSync(hook.launchFile, "utf8");
      const tell = (used: number) => relay(hook.socket, key, JSON.stringify({ contextUsage: { used, window: 200_000 } }));
      await tell(42_013);
      await show({ ...base, agent: null, agent_status: "unknown" }); // The first shell reading may lag the launch.
      expect((await show(session("original")))?.context).toEqual({ used: 42_013, window: 200_000 });
      expect((await show(session("switched-in-process")))?.context).toEqual({ used: 42_013, window: 200_000 });

      if (departure === "shell status event") handlers.onStatus(paneId, "unknown", null);
      else await show({ ...base, agent: "codex" });
      await tell(99_999); // An already queued report from the departed launch must not restore its reading.

      expect((await show(session("manual-replacement")))?.context).toBeUndefined();
      expect(approvals.contextOf(paneId, "omp")).toBeUndefined();
    } finally { approvals.stop(); }
  });
});
