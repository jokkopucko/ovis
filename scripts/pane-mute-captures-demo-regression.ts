// The captures of every state of Mute alerts (pane-mute-demo-run.ts) on the sidebar's agent rows,
// in a phone's drawer too: both widths, both themes, Korean on a phone. It writes into
// UI_EVIDENCE_DIR, which the browser lane sets in CI; with none it has nothing to run and says so.
import { runPaneMute } from "./pane-mute-demo-run.ts";

await runPaneMute("captures");
