import type { PortalSignIn } from "./portal.ts";

/** How a request got in, when it did. */
export type AccessVia = "local" | "tailscale" | "device" | "token" | "open" | "portal" | "relay";
/** Why a request did not. */
export type AccessRefusal = "other_user" | "pairing_required" | "token_required";
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
   * The relay's direct carrier listens on this PC's network (docs/relay.md, "Direct on the same network"),
   * and that is all: only devices paired through the relay sign in there. `host` is then its first address.
   */
  readonly direct?: true;
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
}

/** POST /api/devices/pair/start */
export interface PairingCode {
  readonly code: string;
  readonly expires_at: string;
}

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
