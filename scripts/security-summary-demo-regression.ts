// The checks of the access facts on Settings → Phone & devices, at both widths. The capture matrix
// runs apart, one theme to a script (security-summary-captures-*-demo-regression.ts), so that the
// browser lane's workers share the check instead of one of them running all of it.
import { runSecuritySummary } from "./security-summary-demo-run.ts";

await runSecuritySummary("checks");
