import { ApiError } from "./api.ts";
import type { Translate } from "./i18n.ts";

export type FileFailure = "signed-out" | "forbidden" | "missing" | "limited" | "server" | "offline" | "slow" | "unreadable";

export function fileFailure(reason: unknown): FileFailure {
  if (reason instanceof ApiError) {
    if (reason.code === "machine_timeout") return "slow";
    if (reason.code === "machine_offline" || reason.code === "machine_unavailable") return "offline";
  }
  const relayStatus = reason instanceof TypeError ? /^Relay resource refused: (\d{3})$/.exec(reason.message) : null;
  const status = reason instanceof ApiError ? reason.status : relayStatus ? Number(relayStatus[1]) : null;
  if (status !== null) {
    switch (status) {
      case 401: return "signed-out";
      case 403: return "forbidden";
      case 404: return "missing";
      case 429: return "limited";
      case 408: case 504: return "slow";
      case 502: case 503: return reason instanceof ApiError && reason.code !== null ? "server" : "unreadable";
      default: return status >= 500 ? "server" : "unreadable";
    }
  }
  if (reason instanceof TypeError && /failed to fetch|networkerror|network request failed|load failed/i.test(reason.message)) return "offline";
  if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) return "slow";
  return "unreadable";
}

export function fileFailureText(kind: FileFailure, t: Translate): string {
  switch (kind) {
    case "signed-out": return t("Pair this browser again to open the file.");
    case "forbidden": return t("The PC denied access to this file.");
    case "missing": return t("No readable file at this path.");
    case "limited": return t("Too many file requests. Wait a moment, then reopen it.");
    case "server": return t("The PC could not read the file. Reopen it to try again.");
    case "offline": return t("That PC is not reachable right now.");
    case "slow": return t("The file request timed out. Reopen it to try again.");
    case "unreadable": return t("The file could not be opened.");
  }
}
