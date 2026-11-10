// Attached-terminal touch scrolling, the swipes in the application (terminal-touch-burst-run.ts).
// The swipes over native history, the overflow, the boundaries and the observer run apart
// (terminal-touch-burst-history-regression.ts), so that the browser lane's workers share the check
// instead of one of them running all of it.
import { runTouchBurst } from "./terminal-touch-burst-run.ts";

await runTouchBurst("application");
