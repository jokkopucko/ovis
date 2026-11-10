// The five behaviour sections of the Mute alerts check (pane-mute-demo-run.ts), on the sidebar's
// agent rows and their menu. The captures of every state run apart
// (pane-mute-captures-demo-regression.ts), so that the browser lane's workers share the check
// instead of one of them running all of it.
import { runPaneMute } from "./pane-mute-demo-run.ts";

await runPaneMute("behaviour");
