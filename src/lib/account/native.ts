/**
 * Signing in from the phone app (app/ios/App/App/OvisAuthPlugin.swift, app/android/.../OvisAuthPlugin.java).
 * GitHub, and Apple on Android, open in the system's sign-in sheet or browser and come back to
 * ovis://account/callback; the page finishes with the PKCE verifier it kept, as in a browser. On
 * iOS, Sign in with Apple runs natively: Apple signs the SHA-256 of a random nonce into its
 * identity token, and the account service checks the nonce itself against it (`apple_id_token`).
 */
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { callNative, hasNativePlugin, inAndroidApp } from "../nativeApp.ts";
import { requestToken } from "./service.ts";
import { beginSignIn, finishOwnSignIn } from "./signin.ts";
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";

export const AUTH_PLUGIN = "OvisAuth";
export const NATIVE_REDIRECT = "ovis://account/callback";

export function nativeSignInAvailable(): boolean {
  return hasNativePlugin(AUTH_PLUGIN);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A sign-in whose `wanted` said no once its pending record was written: the sheet was not opened. */
export class SignInNotWanted extends Error {
  constructor() { super("the sign-in was no longer wanted"); this.name = "SignInNotWanted"; }
}

/** `wanted`: asked once the pending record is written, right before the sheet opens; false opens nothing (SignInNotWanted) */
export async function nativeSignIn(provider: AccountProvider, options: { store: AccountStore; service: string; wanted?: () => boolean | Promise<boolean> }): Promise<AccountSession> {
  if (provider === "apple" && !inAndroidApp()) {
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const { idToken } = await callNative<{ idToken: string }>(AUTH_PLUGIN, "signInWithApple", { nonce: await sha256Hex(nonce) });
    const session = await requestToken(options.service, { grant_type: "apple_id_token", id_token: idToken, nonce });
    await options.store.set("session", session);
    return session;
  }
  const url = await beginSignIn(provider, { store: options.store, service: options.service, redirectUri: NATIVE_REDIRECT });
  if (options.wanted !== undefined && !await options.wanted()) throw new SignInNotWanted();
  const { url: callback } = await callNative<{ url: string }>(AUTH_PLUGIN, "authenticate", { url });
  const back = new URL(callback);
  return finishOwnSignIn(url, back.hash.length > 1 ? back.hash : back.search, { store: options.store });
}
