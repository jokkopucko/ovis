import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Keeps only what usage reads from the payload Claude Code hands its status line: the five-hour and
 * weekly windows, and the account of the CLI that drew it (from its config, not whichever account
 * is signed in at read time). A separate per-session file keeps the context window and model.
 * The rest of the payload (cwd, cost, transcript path) is never written.
 */
const home = homedir();
const dir = join(home, ".herdr");
const temp = join(dir, `statusline-last.json.${process.pid}`);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
function window(value: unknown): { used_percentage: number; resets_at?: number } | undefined {
  const found = record(value);
  const used = number(found["used_percentage"]);
  return used === undefined ? undefined : { used_percentage: used, resets_at: number(found["resets_at"]) };
}
/** Context is session-scoped, not account-wide like quota; another pane must not overwrite it. */
function captureContext(body: Record<string, unknown>): void {
  const session = body["session_id"];
  const model = record(body["model"])["id"];
  const capacity = record(body["context_window"])["context_window_size"];
  if (typeof session !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(session)
    || typeof model !== "string" || model.trim() === "" || model.length > 256
    || typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity <= 0) return;
  const contexts = join(dir, "statusline-context");
  const pending = join(contexts, "." + session + "." + randomUUID() + ".tmp");
  try {
    mkdirSync(contexts, { recursive: true, mode: 0o700 });
    if (!lstatSync(contexts).isDirectory()) return;
    chmodSync(contexts, 0o700);
    // The profile fingerprint lets uninstall remove only this installation's captures.
    const profile = createHash("sha256").update(realpathSync(process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"))).digest("hex");
    writeFileSync(pending, JSON.stringify({ session_id: session, model, window: capacity, _herdr: { profile } }), { mode: 0o600, flag: "wx" });
    renameSync(pending, join(contexts, session + ".json"));
  } catch { /* A missing context must not prevent quota capture or the original status line. */ }
  finally { try { rmSync(pending, { force: true }); } catch { /* A blocked directory leaves no temp file. */ } }
}
try {
  const body = record(JSON.parse(await Bun.stdin.text()));
  captureContext(body);
  const limits = record(body["rate_limits"]);
  const fiveHour = window(limits["five_hour"]);
  const sevenDay = window(limits["seven_day"]);
  // a render before Claude's first answer names no limits; the last reading stays
  if (fiveHour === undefined && sevenDay === undefined) process.exit(0);
  const configDir = process.env["CLAUDE_CONFIG_DIR"];
  let account: { id: string; label: string | null } | null = null;
  try {
    const config = JSON.parse(readFileSync(configDir ? join(configDir, ".claude.json") : join(home, ".claude.json"), "utf8"));
    const oauth = config.oauthAccount;
    if (typeof oauth?.accountUuid === "string" && oauth.accountUuid.trim()) {
      account = { id: oauth.accountUuid.trim(), label: typeof oauth.emailAddress === "string" ? oauth.emailAddress : null };
    }
  } catch { /* An unknown account is never attributed to a sign-in by the reader. */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(temp, JSON.stringify({ rate_limits: { five_hour: fiveHour, seven_day: sevenDay }, _herdr: { account } }), { mode: 0o600, flag: "wx" });
  renameSync(temp, join(dir, "statusline-last.json"));
} catch { /* Capture must not prevent the original status line from rendering. */ }
finally { rmSync(temp, { force: true }); }
