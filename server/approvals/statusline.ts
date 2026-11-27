import { captureStatusline, MAX_PAYLOAD_BYTES } from "../statusline-capture.ts";

/**
 * `approval-hook ... --statusline --statusline-command <base64>`: the status line of a Claude Ovis started
 * (server/approvals/claude.ts). It draws the line the user set, the command the launch found (base64), run as Claude
 * runs it (`/bin/sh -c`, the whole payload on its stdin, its output and exit Claude's line); then it keeps what the
 * payload says of the session's context window and of the account's limits, as the installed capture does
 * (server/statusline-capture.ts), where the context ring and Subscription usage read them: Claude hands this line the
 * limits whether or not the Settings switch wraps the user's own line, so they are kept either way, and usage reads
 * them before asking Claude's endpoint. It talks to no hub.
 */
export async function runStatusline(argv: readonly string[]): Promise<void> {
  const at = argv.indexOf("--statusline-command");
  const command = at >= 0 && argv[at + 1] ? Buffer.from(argv[at + 1]!, "base64").toString("utf8") : null;
  const payload = await Bun.stdin.bytes();
  const drawn = command === null ? null : Bun.spawn(["/bin/sh", "-c", command], { stdin: payload, stdout: "inherit", stderr: "inherit" });
  // a payload past the capture's bound is still the line's: only the capture skips it
  if (payload.byteLength <= MAX_PAYLOAD_BYTES) {
    captureStatusline(new TextDecoder().decode(payload), () => true);
  }
  if (drawn !== null) process.exitCode = await drawn.exited;
}
