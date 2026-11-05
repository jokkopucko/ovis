/**
 * The Portal panel's choice of who may open the address (Settings → Phone & devices → Portal), as a
 * form the person edits before Start. The rules for an entry are shared/portal.ts's, the same the
 * server applies.
 */
import { checkEntry, checkPortalAuth, type PortalAuthProblem } from "../../shared/portal.ts";
import type { PortalAuth, PortalAuthMethod, PortalSignIn } from "../../shared/protocol.ts";
import { t } from "./i18n.ts";

/** The identity provider Google's sign-in is, so "Google" in the panel is one choice rather than an address to know. */
export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface AuthDraft {
  readonly method: PortalAuthMethod;
  /** one list a sign-in, so choosing another and back keeps what was typed */
  readonly allow: Readonly<Record<PortalSignIn, readonly string[]>>;
  readonly issuer: string;
  readonly clientId: string;
}

export function methodName(method: PortalSignIn): string {
  switch (method) {
    case "credential": return t("Private link");
    case "siwe": return t("Ethereum wallet");
    case "oidc": return t("Google or company login");
  }
}

/** The form for a sign-in Portal runs or last ran; OIDC starts at Google. */
export function draftOf(auth: PortalAuth): AuthDraft {
  const lists: Record<PortalSignIn, readonly string[]> = { credential: [], siwe: [], oidc: [] };
  if (auth.method !== "none") lists[auth.method] = auth.allow;
  return { method: auth.method, allow: lists, issuer: auth.issuer ?? GOOGLE_ISSUER, clientId: auth.client_id ?? "" };
}

/** What the form asks the server for. Not yet checked: `authProblem` says whether the server would take it. */
export function authOf(draft: AuthDraft): PortalAuth {
  if (draft.method === "none") return { method: "none", allow: [], issuer: null, client_id: null };
  const oidc = draft.method === "oidc";
  return { method: draft.method, allow: draft.allow[draft.method], issuer: oidc ? draft.issuer : null, client_id: oidc ? draft.clientId : null };
}

/** Why the server would refuse the form as it stands, or null; the same words as its answer. */
export function authProblem(draft: AuthDraft): PortalAuthProblem | null {
  const checked = checkPortalAuth(authOf(draft));
  return "problem" in checked ? checked.problem : null;
}

/** `entry` typed into `method`'s list: the list with it, or why it is not one (a repeat included). */
export function withEntry(list: readonly string[], method: PortalSignIn, entry: string): { list: readonly string[] } | { problem: PortalAuthProblem } {
  const checked = checkEntry(method, entry);
  if ("problem" in checked) return checked;
  // a wallet is the same address in any case; Portal compares the rest as they are
  const same = (other: string) => method === "siwe" ? other.toLowerCase() === checked.entry.toLowerCase() : other === checked.entry;
  return list.some(same) ? { problem: "duplicate" } : { list: [...list, checked.entry] };
}

/** Where the provider sends a person back after they sign in: the address to register with it. */
export function redirectAddress(portalUrl: string): string {
  return `${portalUrl}/_portal/auth/callback`;
}
