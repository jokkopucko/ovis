// The phone's Paste key and the input line's Insert (terminal-paste-insert-demo-run.ts): the three
// checks, then the captures of their page and of the light desktop. The other three variants'
// captures run apart (terminal-paste-insert-variants-demo-regression.ts), so that the browser
// lane's workers share the check instead of one of them running all of it.
import { runPasteInsert } from "./terminal-paste-insert-demo-run.ts";

await runPasteInsert("main");
