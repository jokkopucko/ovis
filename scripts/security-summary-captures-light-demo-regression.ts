// The light half of the access facts' capture matrix (security-summary-demo-run.ts): a phone in
// English and in Korean, and a desktop, each state with its focus ring and hover included. It
// writes into UI_EVIDENCE_DIR, which the browser lane sets in CI; with none it has nothing to run
// and says so.
import { runSecuritySummary } from "./security-summary-demo-run.ts";

await runSecuritySummary("captures-light");
