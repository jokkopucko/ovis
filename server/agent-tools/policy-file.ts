import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HARNESS_TOOL_OFF, harnessToolSetting, isRecord, parseHarnessSetting, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { readStateDocument, writeStateDocument } from "../state-document.ts";

export class AgentToolPolicyFile {
  private readonly path: string;
  private epoch: string | null = null;

  constructor(dir: string) { this.path = join(dir, "agent-harness-policy.json"); }
  get paneRunEpoch(): string | null { return this.epoch; }

  read(fallback: unknown): HarnessToolSetting | undefined {
    try {
      const read = readStateDocument(this.path);
      if (read.kind === "missing") {
        // A policy originally stored with the other preferences survives an older server rewriting them.
        if (fallback === undefined) return undefined;
        const policy = harnessToolSetting(fallback);
        this.save(policy);
        return policy;
      }
      if (read.kind !== "json" || !isRecord(read.value)) return HARNESS_TOOL_OFF;
      const { pane_run_epoch: epoch, ...policy } = read.value;
      if (epoch !== undefined) {
        if (typeof epoch !== "string" || !/^[0-9a-f]{32}$/.test(epoch)) return HARNESS_TOOL_OFF;
        this.epoch = epoch;
      }
      return parseHarnessSetting(policy) ?? HARNESS_TOOL_OFF;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // A non-directory cannot contain a policy or a hub.
      return "code" in error && error.code === "ENOTDIR" ? undefined : HARNESS_TOOL_OFF;
    }
  }

  save(policy: HarnessToolSetting, previous: HarnessToolSetting["level"] = policy.level): void {
    // Commit the policy and fence together. An unwritable run registry cannot revive a revoked run at restart.
    const epoch = (previous === "start") !== (policy.level === "start") ? randomUUID().replaceAll("-", "") : this.epoch;
    writeStateDocument(this.path, JSON.stringify(epoch === null ? policy : { ...policy, pane_run_epoch: epoch }), false);
    this.epoch = epoch;
  }
}
