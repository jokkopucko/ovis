import type { HealthInfo } from "./api.ts";
import { useScopedDismissal } from "./dismissedStorage.ts";

/**
 * Whether the line that says the relay's same-Wi-Fi direct connection listens on this PC's network
 * (components/LanExposureNotice.tsx, `direct_exposure`) was dismissed in this browser. It is news
 * once, not a warning: the PC's owner turned direct connections on, and only relay-paired devices sign
 * in there. Settings, Devices and PCs keeps saying it. One dismissal covers one PC at one address: the
 * line comes back when the address changes, or once a health answer says direct is off and it is
 * turned on again. The open-server warning (`lan_exposure`) is never dismissed.
 *
 * `scope` names the PC whose storage this is: its server id in the hosted shell, whose origin all
 * PCs share; "" on a PC's own page, whose origin is that PC.
 */
const KEY = "ovis:direct-notice-dismissed";

/**
 * The direct line's address in this health answer (the open-server warning is not it), null when the
 * answer names none, undefined when it cannot say: no answer yet, or one that did not get in, which
 * never names any exposure (`server/dispatch.ts`).
 */
export function directHostOf(health: Pick<HealthInfo, "auth" | "lan_exposure" | "direct_exposure"> | null): string | null | undefined {
  if (health === null || health.auth?.required === true) return undefined;
  if (health.lan_exposure) return health.lan_exposure.direct === true ? health.lan_exposure.host : null;
  return health.direct_exposure?.host ?? null;
}

export function useDirectNotice(scope: string, host: string | null | undefined): { dismissed: boolean; dismiss: () => void } {
  return useScopedDismissal(KEY, scope, host);
}
