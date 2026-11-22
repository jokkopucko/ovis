/**
 * My machines, Add a machine and a machine's details in a real browser, from fixtures: the
 * states of MY_MACHINES_SCREEN_STATES (scripts/my-machines-states.ts), captured and checked by
 * scripts/my-machines-capture.ts, which says how and takes the same variables:
 *
 *   UI_EVIDENCE_DIR=<dir> bun scripts/my-machines-screens-qa.ts
 */
import { runCaptures } from "./my-machines-capture.ts";
import { MY_MACHINES_SCREEN_STATES } from "./my-machines-states.ts";

await runCaptures(MY_MACHINES_SCREEN_STATES);
