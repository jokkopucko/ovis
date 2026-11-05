import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { encodeOffer } from "../../shared/relay-offer.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import type { RequestServices } from "../dispatch.ts";
import { isJsonObject } from "../http.ts";
import { writePrivateState } from "../private-state.ts";
import { loadRelayIdentity, RelayIdentityError, rotateRelayIdentity } from "./identity.ts";
import type { RelayIdentity } from "./identity.ts";
import { RelayLink } from "./link.ts";
import type { RelayLinkOptions } from "./link.ts";

export interface RelayServiceOptions {
  readonly stateDir: string;
  readonly relay?: string;
  readonly app?: string;
  /** Physical socket factory; tests connect the advertised TLS origin to a local Bun relay. */
  readonly connect?: RelayLinkOptions["connect"];
  readonly clock?: RelayLinkOptions["clock"];
  readonly random?: RelayLinkOptions["random"];
  /** The version WELCOME tells the shell; package.json's by default. The skew QA reports another. */
  readonly serverVersion?: RelayLinkOptions["serverVersion"];
}

/** Only secure origins, without credentials, paths, query, fragments or host lists. */
export function relayEndpoint(input: string, protocol: "wss:" | "https:"): string {
  const url = new URL(input);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error(`Invalid ${protocol} relay origin`);
  return url.origin;
}

export class RelayService {
  private phase: RelayStatus["phase"] = "off";
  private error: string | null = null;
  private blocked: RelayStatus["blocked"] = null;
  private link: RelayLink | undefined;
  private services: RequestServices | undefined;
  private port = 0;
  private identity: RelayIdentity | undefined;
  private enabled = false;
  private shuttingDown = false;
  private resetting = false;
  private ending: Promise<void> = Promise.resolve();
  readonly relay: string;
  readonly app: string;

  constructor(private readonly options: RelayServiceOptions) {
    this.relay = relayEndpoint(options.relay ?? process.env["OVIS_RELAY_URL"] ?? "wss://relay.ovis.sh", "wss:");
    this.app = relayEndpoint(options.app ?? process.env["OVIS_RELAY_APP_URL"] ?? "https://app.ovis.sh", "https:");
  }

  status(): RelayStatus {
    return { phase: this.phase, relay: this.relay, app: this.app, sessions: this.link?.sessions ?? 0,
      blocked: this.blocked, error: this.error };
  }

  /** Boot never enables a missing or damaged state file and never replaces a damaged identity. */
  resume(services: RequestServices, port: number): void {
    this.services = services;
    this.port = port;
    this.blocked = services.serveOnly ? "serve_only" : null;
    try {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(join(this.options.stateDir, "relay", "state.json"), "utf8")); }
      catch (error) {
        if (isJsonObject(error) && error.code === "ENOENT") return;
        throw new Error("Could not read saved relay state.");
      }
      if (!isJsonObject(saved) || typeof saved.enabled !== "boolean") throw new Error("Saved relay state is invalid.");
      if (saved.enabled) this.start();
    } catch (error) { this.failed(error); }
  }

  private failed(error: unknown): void {
    // without a link nothing retries: the relay is off, and the error says why
    this.phase = this.link ? "error" : "off";
    this.error = error instanceof RelayIdentityError ? error.message : "Could not start the relay.";
    if (error instanceof RelayIdentityError) this.blocked = "identity_unreadable";
  }

  start(): RelayStatus {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    if (this.link) return this.status();
    try {
      this.identity = loadRelayIdentity(this.options.stateDir);
      // Authorization reaches disk before the first outbound socket.
      if (services.token === "" && !services.devices.gated) services.devices.closeGate();
      writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: true });
      this.enabled = true;
      this.blocked = null;
      this.error = null;
      this.phase = "connecting";
      const link = new RelayLink({
        relay: this.relay, identity: this.identity, services, port: this.port,
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        onState: (phase, error) => { if (this.link === link) { this.phase = phase; this.error = error; } },
      });
      this.link = link;
      link.start();
    } catch (error) { this.failed(error); }
    return this.status();
  }

  /** A link exists from a successful start until stop; transient failures retry, explicit key refusals do not. */
  get linked(): boolean { return this.link !== undefined; }

  private disconnect(): Promise<void> {
    const link = this.link;
    this.link = undefined;
    this.phase = "off";
    this.error = null;
    this.ending = Promise.all([this.ending, link?.stop()]).then(() => undefined);
    return this.ending;
  }

  async stop(): Promise<RelayStatus> {
    writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: false });
    this.enabled = false;
    await this.disconnect();
    return this.status();
  }

  /** Shutdown preserves the user's saved choice for the next process. */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.disconnect();
  }

  offer(): { url: string; expires_at: string } {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    const pairing = this.services.devices.activePairing() ?? this.services.devices.startPairing();
    // the phone lists the PC under the name Ovis shows for it (server/machines.ts), not its scope URL
    const name = hostname().slice(0, 64);
    return {
      url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key,
        relay: this.relay, code: pairing.code, ...(name ? { name } : {}) }, this.app),
      expires_at: pairing.expires_at,
    };
  }

  async resetIdentity(): Promise<RelayStatus> {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    // Close old admissions before revoking or replacing the key they authenticated against.
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    this.resetting = true;
    try {
      await this.disconnect();
      for (const device of services.devices.list(null)) if (device.via_relay) services.devices.revoke(device.id);
      this.identity = rotateRelayIdentity(this.options.stateDir);
      this.blocked = null;
    } finally { this.resetting = false; }
    return this.enabled ? this.start() : this.status();
  }
}
