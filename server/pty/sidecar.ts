import type { HerdrIdentity } from "../../shared/machines.ts";
import { capabilities } from "../runtime/capabilities.ts";
import { rustSidecar } from "./host.ts";

/**
 * A terminal attach runs on the Rust PTY host (server/pty/host.ts) where it passes its check. A runtime
 * without one (Windows, or a PC where the host cannot run) cannot start one, whatever herdr itself can
 * do, so its panes stay mirrored.
 */
export function sidecarAvailable(): boolean {
  return rustSidecar() !== null;
}

/**
 * Where the runtime's live terminal is a stream (`streamed`: on herdr-core, one on the server's own hc
 * connection, server/herdr-core/attach-session.ts), no PTY host is needed.
 */
export function attachableIdentity(identity: HerdrIdentity, sidecar: boolean, streamed = capabilities().attach !== "pty-cli"): HerdrIdentity {
  if (sidecar || streamed || identity.terminal_attach === false) return identity;
  return { ...identity, terminal_attach: false, terminal_mirror: true };
}
