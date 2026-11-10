// Attached-terminal touch scrolling over herdr's native history, then the overflow, the boundaries
// and the concurrent observer: one part of terminal-touch-burst-run.ts, apart from the swipes in
// the application (terminal-touch-burst-regression.ts).
import { runTouchBurst } from "./terminal-touch-burst-run.ts";

await runTouchBurst("history");
