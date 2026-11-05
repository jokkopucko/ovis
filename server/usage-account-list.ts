import { join } from "node:path";
import type { UsageReport } from "../shared/protocol.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { withOwnerGuard } from "./owner-guard.ts";
import { readStateDocument, setAsideDamaged, writeStateDocument } from "./state-document.ts";
import type { UsageService } from "./usage.ts";

/**
 * Accounts removed from Ovis, not signed out of their CLIs. Only public account keys are saved;
 * no credential home, keychain item or token is changed. Restore (POST) or a successful followed
 * sign-in of that account brings it back; token refreshes and server restarts do not.
 */
export class UsageAccountList {
  private readonly path: string;

  constructor(stateDir: string, private readonly usage: Pick<UsageService, "report">) {
    this.path = join(stateDir, "usage-removed.json");
  }

  /**
   * The removed keys. A file that is not the list (bytes that are not JSON, another shape) is set
   * aside as `<path>.corrupt-<time>` and counts as empty, so it never blanks every meter; one that
   * cannot be read or set aside throws.
   */
  private read(): string[] {
    const document = readStateDocument(this.path);
    if (document.kind === "missing") return [];
    if (document.kind === "json" && isJsonObject(document.value)) {
      const keys = document.value["accounts"];
      if (Array.isArray(keys) && keys.every((key): key is string => typeof key === "string" && key.length > 0)) return keys;
    }
    const aside = setAsideDamaged(this.path);
    console.error(`${this.path} is not a list of removed accounts; it was set aside as ${aside}, and every account is listed again`);
    return [];
  }

  /** Changes the list under the state dir's guard, so two servers on one state dir never drop each other's change. */
  private change(next: (held: string[]) => string[]): void {
    withOwnerGuard(this.path, () => {
      const held = this.read();
      const changed = next(held);
      if (changed.length !== held.length) writeStateDocument(this.path, JSON.stringify({ accounts: changed }), false);
    });
  }

  restore(key: string): void {
    this.change((held) => held.filter((account) => account !== key));
  }

  /** The usage report without the removed accounts; those this PC still lists come under `removed`, to be restored. */
  async report(refresh = false): Promise<UsageReport> {
    const report = await this.usage.report(refresh);
    let removed: Set<string>;
    // under the guard too: a damaged file is set aside only while no other server can have replaced it
    try { removed = new Set(withOwnerGuard(this.path, () => this.read())); }
    catch (error) {
      // an unreadable list hides nothing: every meter stays rather than none
      console.warn("Could not read the removed accounts list", error instanceof Error ? error.message : String(error));
      return report;
    }
    const listed = report.providers.filter((account) => !removed.has(account.key));
    const hidden = report.providers.filter((account) => removed.has(account.key));
    return { ...report, providers: listed, ...(hidden.length > 0 ? { removed: hidden } : {}) };
  }

  /** DELETE removes a listed account from Ovis; POST restores a removed one. */
  async handle(request: Request): Promise<Response> {
    if (request.method !== "DELETE" && request.method !== "POST") {
      return jsonResponse({ error: { code: "method_not_allowed", message: "Use DELETE or POST /api/usage/accounts" } }, 405, { allow: "DELETE, POST" });
    }
    const body: unknown = await request.json().catch(() => null);
    if (!isJsonObject(body) || Object.keys(body).length !== 1 || typeof body["account"] !== "string" || body["account"].length === 0) {
      return badRequest("invalid_account", "Name one listed account");
    }
    const key = body["account"];
    if (request.method === "POST") {
      this.restore(key);
      return new Response(null, { status: 204 });
    }
    const report = await this.usage.report();
    if (!report.providers.some((account) => account.key === key)) return jsonResponse({ error: { code: "account_not_found", message: "This PC no longer lists that account" } }, 404);
    this.change((held) => held.includes(key) ? held : [...held, key]);
    return new Response(null, { status: 204 });
  }
}
