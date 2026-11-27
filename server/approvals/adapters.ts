import { claudeApprovals } from "./claude.ts";
import { copilotApprovals } from "./copilot.ts";
import type { ApprovalAdapter } from "./hub.ts";
import { omoApprovals } from "./omo.ts";
import { ompApprovals } from "./omp.ts";
import { piApprovals } from "./pi.ts";

/** Every agent whose launch gets Ovis's hook, as the server's ApprovalHub serves them; scripts/harness-drift.ts checks their versions. */
export const APPROVAL_ADAPTERS: readonly ApprovalAdapter[] = [claudeApprovals, piApprovals, omoApprovals, ompApprovals, copilotApprovals];
