import type { HealthAuth } from "../../shared/protocol.ts";
import { fetchBridgeHealth, signOut, signOutOfPortal } from "./api.ts";

/**
 * Whether this browser can end the sign-in it got in with: a token it typed or a paired device's,
 * and Portal's own sign-in, which Portal clears (`signOutOfPortal`). Not this PC's own access, the
 * Tailscale login or an open server, which nothing here holds; nor a token a proxy sends with every
 * request, which would come right back.
 */
export function canSignOut(auth: HealthAuth | null): boolean {
  if (auth?.authenticated !== true) return false;
  return auth.via === "device" || auth.via === "portal" || (auth.via === "token" && auth.bearer !== true);
}

/**
 * Ends this browser's sign-in the way it got in, and says whether the page must reload to show
 * what follows: Portal answers every request without its session with its own sign-in page, so
 * a browser Portal signed in loads that; the others ask the app, which then shows its own gate.
 * A browser can hold the app's sign-in and Portal's at once, and the app's is the one that counts
 * first: when Portal's is what is left once it is gone, the same click ends that too. That is read
 * from the bridge's health, which answers while herdr is down, as signing out must.
 */
export async function endSignIn(via: HealthAuth["via"]): Promise<{ reload: boolean }> {
  if (via !== "portal") {
    await signOut();
    if ((await fetchBridgeHealth()).auth.via !== "portal") return { reload: false };
  }
  await signOutOfPortal();
  return { reload: true };
}
