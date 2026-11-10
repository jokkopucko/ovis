// A running subagent's detail sheet through its whole flow, in the four views: opened from the
// composer's background-task list and from the sidebar's rows and resting line, its focus trap, the
// focus going back to the row, and its text open to selection. The states a read can end in run
// apart, one view to a script (background-agent-states-*-demo-regression.ts), so that the browser
// lane's workers share the check instead of one of them running all of it.
import { runBackgroundAgentDetail } from "./background-agent-detail-demo-run.ts";

await runBackgroundAgentDetail("flow");
