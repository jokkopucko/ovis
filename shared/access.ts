import type { PortalSignIn } from "./portal.ts";

export type AccessVia = "local" | "tailscale" | "device" | "token" | "open" | "portal" | "relay";
export type AccessRefusal = "other_user" | "pairing_required" | "token_required" | "locked" | "strict";
/** What a paired device may do: drive (type, answer, manage) or only watch. */
export type DeviceRole = "drive" | "watch";

/** Who Portal's own sign-in let in, as it states it to the app (server/access.ts `portalLogin`). */
export interface PortalLogin {
  /** the wallet address, link name, or verified email or sub:<id> that signed in */
  readonly user: string;
  readonly method: PortalSignIn;
}

/** GET /api/health `auth`: `authenticated` is whether this request got in; `required` is the opposite, kept for older clients. */
export interface HealthAuth {
  readonly required: boolean;
  readonly authenticated: boolean;
  readonly via?: AccessVia;
  /** with `via: "token"`: the token came in an `Authorization` header (a proxy sends it), so signing out of this browser would change nothing */
  readonly bearer?: true;
  readonly role?: DeviceRole;
  /** with `via: "portal"`: who signed in through Portal */
  readonly portal?: PortalLogin;
  readonly reason?: AccessRefusal;
  /**
   * account-opens-all/1: this request is this PC's own window (loopback with no proxy, or the access token from there),
   * the rule the lock routes apply themselves. A display hint for the window about itself: it grants nothing.
   */
  readonly own_window?: true;
}

/**
 * GET /api/health, authenticated requests only: this server answers on an address beyond this
 * PC while no access token is set and no device has ever been paired, so anything that can
 * reach that address is let in (`open` in `server/access.ts`). It is a warning, never a gate:
 * nothing about who is let in changes because this field exists.
 *
 * Never sent to a request that did not get in. "This host runs Ovis with no token"
 * is reconnaissance for whoever is asking, not help.
 */
export interface LanExposure {
  /** the address the server is bound to, so the warning can name where it is reachable */
  readonly host: string;
  /**
   * Only from the 0.4.23 betas, which named the relay's direct carrier here: `host` is then that
   * carrier's address, and the client words it as DirectExposure. This server sends DirectExposure instead.
   */
  readonly direct?: true;
}

/**
 * GET /api/health, as `direct_exposure`, to a request that got in, while LanExposure is not sent: the
 * relay's direct carrier listens on this PC's network (docs/relay.md, "Direct on the same network"),
 * and that is all: only devices paired through the relay sign in there. Its own field, not a flag on
 * `lan_exposure`: a 0.4.x client takes any `lan_exposure` for an open server and warns that anyone
 * on the network can type into every pane.
 */
export interface DirectExposure {
  /** the direct carrier's first address */
  readonly host: string;
}

/** The configured bind address, read from its literal (`bindScope` in server/access.ts): never a DNS lookup or the request's Host. */
export type BindScope = "loopback" | "tailnet" | "other";
/** How this one request arrived, as far as it proves (`observedIngress` in server/access.ts); not how every device reaches the server. `direct`: no proxy said it forwarded the request, which a proxy that adds nothing (an SSH tunnel, nginx's bare `proxy_pass`) also looks like. `portal`: Portal vouched for the request with its proof, whatever signed it in (the token or a paired device too), or, running with no sign-in and so with no proof, it came from this PC in the shape Portal forwards to an address that Portal serves. */
export type ObservedIngress = "direct" | "proxy" | "tailscale" | "funnel" | "unknown" | "relay" | "portal";

/**
 * GET /api/health (both scopes), authenticated requests only, a watching device's included:
 * what protects this server, each fact on its own and none of them a verdict. It carries no
 * token, hash, header, login or address, and is sent `no-store`. Anonymous answers omit it, and
 * an older server sends none: the client then says the facts are unavailable rather than
 * reading them from `auth` or from the absence of `lan_exposure`.
 */
export interface SecuritySummary {
  /** an access token is configured on the server, whether or not this request used it */
  readonly token_configured: boolean;
  /** the durable pairing gate (`DeviceStore.gated`); `unavailable` when devices.json cannot be read, which keeps it closed */
  readonly pairing_gate: "open" | "closed" | "unavailable";
  readonly bind_scope: BindScope;
  readonly observed_ingress: ObservedIngress;
  /** `observed` only with trusted public-ingress evidence on this request (Funnel); otherwise unknown, never "none" */
  readonly public_exposure: "observed" | "unknown";
}

export interface PairedDevice {
  readonly id: string;
  readonly label: string;
  readonly role: DeviceRole;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  /** the device this request came from */
  readonly current: boolean;
  /** paired with a public key for relay access, not a browser cookie */
  readonly via_relay?: true;
  /** account members only, and only to a caller that may drive (docs/account.md, "Account members") */
  readonly account?: string;
  /** that member's account key: its `relay_public_key`, which is public */
  readonly account_key?: string;
  /** the member on this PC that added it */
  readonly added_by?: string;
  /** how it reaches this PC right now, while one of its encrypted sessions is up; absent while none is */
  readonly connection?: DeviceConnection;
  /** To the PC's own window: a signed Not me is waiting for this exact device's account order. */
  readonly not_me_waiting?: true;
  /**
   * account-opens-all/1, to a remote caller only: whether it may Revoke this row from afar (device table T19 in 2d).
   * `allowed`: the entire Revoke is in scope; `older` and `unorderable` require a different caller;
   * `read_only`: this caller can only watch.
   */
  readonly remote_revoke?: "allowed" | "older" | "unorderable" | "read_only";
}

/**
 * Which way a device's session reaches the PC: straight on the same network (`lan`), straight over
 * Tailscale, or through a relay. A matter of speed only: every way carries the same end-to-end channel.
 */
export type DeviceRoute = "lan" | "tailscale" | "relay";

export interface DeviceConnection {
  readonly route: DeviceRoute;
  /** the relay's address (`wss://…`), for `relay` only: Ovis's regional ones are named by place */
  readonly relay?: string;
  /** the latest keepalive's round trip, PC to device and back; null until one came back */
  readonly rtt_ms: number | null;
  /** when this session signed in */
  readonly since: string;
}

/** POST /api/devices/pair/start */
export interface PairingCode {
  readonly code: string;
  readonly expires_at: string;
}

/**
 * What POST /api/relay/code and POST /api/relay/offer add to their answer for a code made for an account
 * (`x-ovis-expect-account`; docs/account.md, "A code made for an account"). An older PC answers neither field.
 */
export interface AccountPairing {
  /** the account the call named: only a device that links itself into it becomes a device of this PC */
  readonly expect_account: string;
  /** `id` names the code for POST /api/relay/offer/keep */
  readonly pairing: { readonly id: string };
}

/** Why a code made for an account ended. */
export type AccountPairingEnd = "joined" | "overused" | "expired" | "replaced" | "cancelled" | "revoked" | "guessed";

/**
 * What the last link of a device that paired with such a code did: none yet (`not_sent`), one answered at once
 * (`sent`), one that waits for the account service's word (`asked`), or one the account service did not answer for
 * (`service_unreachable`).
 */
export type AccountPairingLink = "not_sent" | "sent" | "asked" | "service_unreachable";

/**
 * A device that paired with such a code and went without becoming a member: its link named another account
 * (`account_mismatch`, with that `account`), the account service did not vouch for its key (`unverified`), its 30
 * seconds ran out (`link_timeout`), it sent too many links (`link_refused`), the code ended (`code_ended`), or its key
 * was removed (`removed`). `n` counts from 1; `label` is the device's own word.
 */
export interface AccountPairingTurnedAway {
  readonly n: number;
  readonly id: string;
  readonly label: string;
  readonly why: "account_mismatch" | "unverified" | "link_timeout" | "link_refused" | "code_ended" | "removed";
  readonly link: AccountPairingLink;
  readonly account?: string;
}

/**
 * POST /api/relay/offer/keep { id }: whether a code made for an account is still the pending one, and how it ended.
 * `joined` names the device that linked itself into the account with this code, when one did. `unknown`: the PC
 * knows no such code (it restarted, or the code ended long ago). `waiting`: the devices that paired with it and have
 * not linked yet; `turned_away`: every device of it that went without becoming a member, oldest first;
 * `service_retry_ms`: how long until the PC may ask the account service again, 0 when it may now.
 */
export type AccountPairingState =
  | { readonly state: "live"; readonly id: string; readonly expect_account: string; readonly expires_at: string;
    readonly waiting: readonly { readonly id: string; readonly label: string; readonly link: AccountPairingLink }[];
    readonly turned_away: readonly AccountPairingTurnedAway[]; readonly service_retry_ms?: number }
  | { readonly state: "ended"; readonly id: string; readonly expect_account: string; readonly ended: { readonly why: AccountPairingEnd; readonly at: string };
    readonly joined?: { readonly device_id: string; readonly label: string }; readonly turned_away: readonly AccountPairingTurnedAway[] }
  | { readonly state: "unknown" };

/** GET /api/access: how a phone can reach this server, as far as the server can tell (Settings → Phone). */
export interface RemoteAccess {
  /** the port this server listens on; the tailscale command names it */
  readonly port: number;
  readonly tailscale: TailscaleAccess;
}

/** Read from `tailscale status --json` and `tailscale serve status --json`, never by changing anything. */
export interface TailscaleAccess {
  /** missing: no tailscale CLI on this PC; stopped: the CLI is there but the daemon is not running or not logged in */
  readonly state: "missing" | "stopped" | "running";
  /** this PC's MagicDNS name, without the trailing dot */
  readonly dns_name: string | null;
  /** the HTTPS address Tailscale already proxies to this server, when there is one */
  readonly serving_url: string | null;
  /** otherwise, the command that publishes it on the first free of the usual HTTPS ports, or on the one OVIS_TAILSCALE_HTTPS_PORT names while it is free ... */
  readonly serve_command: string | null;
  /** ... and the address that command gives, when the DNS name is known */
  readonly serve_url: string | null;
}
