import { homedir } from "node:os";

import { captureContext, captureStatusline, MAX_PAYLOAD_BYTES } from "../statusline-capture.ts";
import { statuslineInstallState } from "../statusline-install.ts";

/**
 * `approval-hook ... --statusline --statusline-command <base64>`: the status line of a Claude Ovis started
 * (server/approvals/claude.ts). It draws the line the user set, the command the launch found (base64), run as Claude
 * runs it (`/bin/sh -c`, the whole payload on its stdin, its output and exit Claude's line); then it keeps what the
 * payload says of the session's context window, as the installed capture does (server/statusline-capture.ts), where
 * the context ring reads it. The limits and the account are kept only while the Settings switch is on, as its own
 * wrapper (which this line stands in for, configuredStatusLine) would keep them. It talks to no hub.
 */
export async function runStatusline(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const at = argv.indexOf("--statusline-command");
  const command = at >= 0 && argv[at + 1] ? Buffer.from(argv[at + 1]!, "base64").toString("utf8") : null;
  const payload = await Bun.stdin.bytes();
  const drawn = command === null ? null : Bun.spawn(["/bin/sh", "-c", command], { stdin: payload, stdout: "inherit", stderr: "inherit" });
  // a payload past the capture's bound is still the line's: only the capture skips it
  if (payload.byteLength <= MAX_PAYLOAD_BYTES) {
    try {
      const text = new TextDecoder().decode(payload);
      const switchOn = () => statuslineInstallState({ home: homedir(), configDir: env["CLAUDE_CONFIG_DIR"] }).installed;
      if (switchOn()) captureStatusline(text, switchOn);
      else {
        const body: unknown = JSON.parse(text);
        if (typeof body === "object" && body !== null && !Array.isArray(body)) captureContext(body as Record<string, unknown>, () => true);
      }
    } catch { /* the line is what matters here */ }
  }
  if (drawn !== null) process.exitCode = await drawn.exited;
}
