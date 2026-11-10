// The captures of Paste and Insert on a dark phone, a Korean phone and a dark desktop: one part of
// terminal-paste-insert-demo-run.ts. It writes into UI_EVIDENCE_DIR, which the browser lane sets in
// CI; with none it has nothing to run and says so.
import { runPasteInsert } from "./terminal-paste-insert-demo-run.ts";

await runPasteInsert("variants");
