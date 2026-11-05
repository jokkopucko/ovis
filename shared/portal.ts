/**
 * GET /api/portal: a public HTTPS address for this server through the Portal on its PC
 * (gosuda/portal-tunnel), which the app starts and stops (Settings → Phone & devices).
 */
export interface PortalStatus {
  /** false on a server started without Portal (tests, the demo): the section stays hidden */
  readonly supported: boolean;
  /** what `portal version` says of the `portal` on PATH; null when there is none or it does not answer */
  readonly version: string | null;
  /** the oldest Portal that can run this app's tunnel */
  readonly min_version: string;
  /** `version` is `min_version` or later: Start is offered */
  readonly usable: boolean;
  /** recovering: a Portal that was serving ended on its own and is started again, once, with no address meanwhile */
  readonly phase: "idle" | "starting" | "running" | "recovering" | "stopping" | "error";
  /** the relay the tunnel uses, or used last; an https origin */
  readonly relay: string | null;
  /** the public address while it runs, without the default port */
  readonly url: string | null;
  /** the short address Portal also serves for its `--name` while it runs; null when it printed none. Absent from an older server */
  readonly short_url?: string | null;
  /** why a start would be refused now: no token set, or tailscale serve declared the only way in */
  readonly blocked: "token_required" | "serve_only" | null;
  /** what went wrong last; null after a success */
  readonly error: string | null;
  /** the tail of what Portal printed, for when the error alone does not say enough */
  readonly output: string | null;
  /** who may open the address: what runs now, else what the next start uses (the last choice, kept across restarts) */
  readonly auth: PortalAuth;
  /** the sign-ins the `portal` on this PC offers, read from the flags its `expose --help` lists; none when it is too old or missing */
  readonly auth_methods: readonly PortalSignIn[];
  /** OVIS_PORTAL_OIDC_CLIENT_SECRET is set on this PC; its value never leaves it */
  readonly oidc_secret: boolean;
}

/** Portal's own sign-in in front of the whole address, besides the app's token and paired devices. */
export const PORTAL_SIGN_INS = ["credential", "siwe", "oidc"] as const;
export type PortalSignIn = (typeof PORTAL_SIGN_INS)[number];

/** `none`: Portal asks nobody anything, and the app's own token or a paired device lets a visitor in, as it always did. */
export type PortalAuthMethod = "none" | PortalSignIn;

/** The sign-in as `portal expose --auth` takes it, checked by `checkPortalAuth`. */
export interface PortalAuth {
  readonly method: PortalAuthMethod;
  /**
   * `--auth-allow`: link names (credential), Ethereum addresses (siwe), verified emails, @domains
   * and sub:<id> (oidc). An empty credential list lets in every unexpired link; siwe and oidc need
   * at least one entry (checkPortalAuth).
   */
  readonly allow: readonly string[];
  /** oidc only: the identity provider's https address */
  readonly issuer: string | null;
  /** oidc only: the client ID registered at the provider; its secret is OVIS_PORTAL_OIDC_CLIENT_SECRET, never here */
  readonly client_id: string | null;
}

export const NO_PORTAL_AUTH: PortalAuth = { method: "none", allow: [], issuer: null, client_id: null };

/** The environment variable of the server's PC that holds the OIDC client secret, which no request, file or answer carries. */
export const PORTAL_OIDC_SECRET_VARIABLE = "OVIS_PORTAL_OIDC_CLIENT_SECRET";

/** Why a check refuses. */
export type PortalAuthProblem = "invalid" | "name" | "wallet" | "principal" | "duplicate" | "no_wallet" | "no_principal" | "issuer" | "client_id";

/** What a check refuses, in the words the server answers with and the panel shows (translated there: src/lib/i18n.test.ts reads this map). */
export const PORTAL_AUTH_PROBLEMS: Record<PortalAuthProblem, string> = {
  invalid: "The sign-in settings are not valid.",
  name: "A link name is 1 to 256 printable ASCII characters; spaces are fine.",
  wallet: "A wallet is an Ethereum address: 0x and 40 hexadecimal digits.",
  principal: "Use an email address, @example.com for a whole domain, or sub:<id>, in ASCII with no spaces.",
  duplicate: "That one is already on the list.",
  no_wallet: "Add at least one wallet: with none, any wallet could sign in.",
  no_principal: "Add at least one email, @domain or sub:<id>: Portal will not start Google or company login without one.",
  issuer: "The provider is an https address with no query or fragment, such as https://accounts.google.com.",
  client_id: "Enter the client ID your provider gave you: up to 256 characters, no spaces.",
};

type Checked<T> = T | { readonly problem: PortalAuthProblem };

/**
 * One `--auth-allow` entry, as Portal reads it. Names and ids are narrower than Portal's own rules
 * (printable ASCII, not any non-control character): a visitor's name reaches this server in an HTTP
 * header, which carries nothing else, so a name outside ASCII could never sign in.
 */
export function checkEntry(method: PortalSignIn, raw: string): Checked<{ readonly entry: string }> {
  const text = raw.trim();
  if (method === "credential") return /^[\x20-\x7e]{1,256}$/.test(text) ? { entry: text } : { problem: "name" };
  if (method === "siwe") return /^0x[0-9a-f]{40}$/i.test(text) ? { entry: text } : { problem: "wallet" };
  // sub:<id> keeps its case, an email or @domain is lower-cased, as Portal compares them
  if (/^sub:/i.test(text)) {
    const id = text.slice("sub:".length).trim();
    return /^[\x20-\x7e]{1,256}$/.test(id) ? { entry: `sub:${id}` } : { problem: "principal" };
  }
  return /^[\x21-\x3f\x41-\x7e]*@[\x21-\x3f\x41-\x7e]+$/.test(text) ? { entry: text.toLowerCase() } : { problem: "principal" };
}

/** The identity provider's address as Portal takes it: https, no credentials, query or fragment, no trailing slash. */
export function checkIssuer(raw: string): Checked<{ readonly issuer: string }> {
  const text = raw.trim().replace(/\/+$/, "");
  let url: URL | null = null;
  try { url = new URL(text); } catch { /* refused below */ }
  const plain = url !== null && url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
  // a `?` or `#` anywhere is a query or fragment, even an empty one the URL parser would not report
  return plain && /^[\x21-\x7e]{1,2048}$/.test(text) && !/[?#]/.test(text) ? { issuer: text } : { problem: "issuer" };
}

export function checkClientId(raw: string): Checked<{ readonly clientId: string }> {
  const text = raw.trim();
  return /^[\x21-\x7e]{1,256}$/.test(text) ? { clientId: text } : { problem: "client_id" };
}

/**
 * A request's or the saved state's sign-in, settled: entries in Portal's form and without
 * duplicates, the OIDC fields only for OIDC. Unset is no sign-in. Refuses what Portal would refuse
 * at its start (OIDC needs an issuer, a client ID and an entry) and one list Portal accepts but this
 * app does not: Ethereum with no wallet, which would let any wallet in to every terminal.
 */
export function checkPortalAuth(input: unknown): Checked<{ readonly auth: PortalAuth }> {
  if (input === undefined || input === null) return { auth: NO_PORTAL_AUTH };
  if (typeof input !== "object" || Array.isArray(input)) return { problem: "invalid" };
  const { method, allow = [], issuer, client_id } = input as Record<string, unknown>;
  if (method === "none") return { auth: NO_PORTAL_AUTH };
  const signIn = PORTAL_SIGN_INS.find((candidate) => candidate === method);
  if (signIn === undefined || !Array.isArray(allow) || !allow.every((entry) => typeof entry === "string")) return { problem: "invalid" };
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const raw of allow as string[]) {
    const checked = checkEntry(signIn, raw);
    if ("problem" in checked) return checked;
    const key = signIn === "siwe" ? checked.entry.toLowerCase() : checked.entry;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(checked.entry);
    }
  }
  if (signIn === "siwe" && entries.length === 0) return { problem: "no_wallet" };
  if (signIn !== "oidc") return { auth: { method: signIn, allow: entries, issuer: null, client_id: null } };
  if (entries.length === 0) return { problem: "no_principal" };
  const provider = checkIssuer(typeof issuer === "string" ? issuer : "");
  if ("problem" in provider) return provider;
  const client = checkClientId(typeof client_id === "string" ? client_id : "");
  if ("problem" in client) return client;
  return { auth: { method: "oidc", allow: entries, issuer: provider.issuer, client_id: client.clientId } };
}

/** How long a private link lasts, in days, to choose from. */
export const PORTAL_INVITE_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_INVITE_DAYS = 30;

/** POST /api/portal/invite: the link to send. It is a bearer secret, shown once and kept nowhere. */
export interface PortalInvite {
  readonly redeem_url: string;
}
