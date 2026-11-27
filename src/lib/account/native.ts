/**
 * Signing in from the phone app (app/ios/App/App/OvisAuthPlugin.swift, app/android/.../OvisAuthPlugin.java).
 * GitHub, and Apple on Android, open in the system's sign-in sheet or browser and come back to
 * ovis://account/callback; the page finishes with the PKCE verifier it kept, as in a browser. On
 * iOS, Sign in with Apple runs natively: Apple signs the SHA-256 of a random nonce into its
 * identity token, and the account service checks the nonce itself against it (`apple_id_token`).
 * Adding Apple on iOS uses the sheet instead: the link token goes through the redirect flow.
 */
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { callNative, hasNativePlugin, inAndroidApp } from "../nativeApp.ts";
import type { SignInCreation } from "./accountHint.ts";
import { AccountService, requestToken } from "./service.ts";
import { beginSignIn, finishIssuedSignIn, finishOwnSignIn, takePendingSignIn, type FinishOptions } from "./signin.ts";
import type { AccountProvider, AccountSession, AccountStore, LinkSignIn } from "./store.ts";

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
export async function nativeSignIn(provider: AccountProvider, options: {
  readonly store: AccountStore;
  readonly service: string;
  readonly wanted?: () => boolean | Promise<boolean>;
  readonly fetch?: FinishOptions["fetch"];
  readonly creation?: SignInCreation;
  readonly link?: { readonly linkToken: string; readonly link: LinkSignIn; readonly generation: string };
}): Promise<AccountSession> {
  const { link } = options;
  if (provider === "apple" && link === undefined && !inAndroidApp()) {
    const generation = await AccountService.signInGeneration(options.store);
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const { idToken } = await callNative<{ idToken: string }>(AUTH_PLUGIN, "signInWithApple", { nonce: await sha256Hex(nonce) });
    await AccountService.checkGeneration(options.store, generation);
    const session = await requestToken(options.service, { grant_type: "apple_id_token", id_token: idToken, nonce });
    return finishIssuedSignIn(session, generation, options);
  }
  const url = await beginSignIn(provider, { store: options.store, service: options.service, redirectUri: NATIVE_REDIRECT,
    ...options.creation,
    ...(link === undefined ? {} : { linkToken: link.linkToken, generation: link.generation, link: link.link }) });
  let back: URL;
  try {
    if (options.wanted !== undefined && !await options.wanted()) throw new SignInNotWanted();
    if (link !== undefined) await AccountService.checkGeneration(options.store, link.generation);
    const { url: callback } = await callNative<{ url: string }>(AUTH_PLUGIN, "authenticate", { url });
    back = new URL(callback);
  } catch (error) {
    await takePendingSignIn(options.store, new URL(url).searchParams.get("state") ?? "");
    throw error;
  }
  return finishOwnSignIn(url, back.hash.length > 1 ? back.hash : back.search, { store: options.store,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
}
