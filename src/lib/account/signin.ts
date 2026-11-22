/**
 * Signing in with GitHub, Google or Apple through the account service: OAuth's authorization code with
 * PKCE, the service standing between this client and the provider. The service sends the browser
 * back with the code in the fragment, which no request carries, so the code never reaches the
 * host that serves the app.
 */
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { AccountServiceError, requestToken } from "./service.ts";
import type { AccountProvider, AccountSession, AccountStore, PendingPairing, PendingSignIn } from "./store.ts";

/** A sign-in left at the provider's pages longer than this is not finished: its return is refused. */
export const SIGN_IN_MS = 10 * 60_000;

export class SignInError extends Error {
  /** `in_use`: a sign-in that was to add a method found an identity another account already has */
  constructor(readonly code: "no_sign_in" | "expired" | "denied" | "unsupported" | "in_use", message: string) {
    super(message);
    this.name = "SignInError";
  }
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

function random(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Where to send the browser to sign in; the verifier and state wait in the store for the return.
 * `linkToken` (AccountService.addMethod) adds the provider to the signed-in account instead. `pairing` waits in the
 * same record, so only this sign-in's return takes it, and it goes when the sign-in does.
 */
export async function beginSignIn(provider: AccountProvider, options: { store: AccountStore; service: string; redirectUri: string; now?: () => number; linkToken?: string; pairing?: PendingPairing }): Promise<string> {
  const verifier = random(32);
  const state = random(16);
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const now = (options.now ?? Date.now)();
  const pending: PendingSignIn = { service: options.service, provider, state, verifier, redirect_uri: options.redirectUri, started_at: now, ...(options.pairing ? { pairing: options.pairing } : {}) };
  // one per state: another tab's sign-in stays, and only ones past their time are dropped
  await options.store.update("pending", (current) => ({
    ...Object.fromEntries(Object.entries(current ?? {}).filter(([, waiting]) => now - waiting.started_at <= SIGN_IN_MS)),
    [state]: pending,
  }));
  const url = new URL(`/v1/signin/${provider}`, options.service);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.linkToken !== undefined) url.searchParams.set("link_token", options.linkToken);
  return url.href;
}

export type SignInReturn = { code: string; state: string } | { error: string; state: string };

export function signInReturn(params: string): SignInReturn | null {
  const fields = new URLSearchParams(params.replace(/^[#?]/, ""));
  const state = fields.get("state");
  if (state === null) return null;
  const code = fields.get("code");
  if (code !== null) return { code, state };
  const error = fields.get("error");
  return error === null ? null : { error, state };
}

/**
 * Trades the returned code for a session, once: the sign-in its `state` names is taken in one
 * transaction, so a return opened twice does nothing, and one this client never started touches no
 * sign-in that is still waiting.
 */
export interface FinishOptions {
  readonly store: AccountStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  /**
   * the signed-in session's access token: a linking sign-in is redeemed by the sign-in that asked for
   * it, and is not stored here; AccountService.addMethod keeps it only if that sign-in is still current
   */
  readonly bearer?: string;
}

/** Takes the sign-in `state` names out of the store, in one transaction: a second take, or any other state, gets nothing. */
export async function takePendingSignIn(store: AccountStore, state: string): Promise<PendingSignIn | undefined> {
  let pending: PendingSignIn | undefined;
  await store.update("pending", (current) => {
    pending = current?.[state];
    if (pending === undefined) return current;
    const { [state]: _taken, ...rest } = current ?? {};
    return rest;
  });
  return pending;
}

export async function finishSignIn(returned: SignInReturn, options: FinishOptions): Promise<AccountSession> {
  return redeemSignIn(await takePendingSignIn(options.store, returned.state), returned, options);
}

/** Trades the code of a sign-in already taken (takePendingSignIn) for a session; nothing of it is left in the store. */
export async function redeemSignIn(pending: PendingSignIn | undefined, returned: SignInReturn, options: FinishOptions): Promise<AccountSession> {
  const now = options.now ?? Date.now;
  if (pending === undefined) throw new SignInError("no_sign_in", "This sign-in was not started here, or has finished");
  if (now() - pending.started_at > SIGN_IN_MS) throw new SignInError("expired", "The sign-in took too long");
  if ("error" in returned && returned.error === "invalid_link") throw new SignInError("expired", "The link to add a sign-in method ran out");
  if ("error" in returned) throw new SignInError("denied", "The sign-in was cancelled or refused");
  let session: AccountSession;
  try {
    session = await requestToken(pending.service, {
      grant_type: "authorization_code", code: returned.code, code_verifier: pending.verifier, redirect_uri: pending.redirect_uri,
    }, { ...(options.fetch ? { fetch: options.fetch } : {}), now, ...(options.bearer === undefined ? {} : { bearer: options.bearer }) });
  } catch (error) {
    if (error instanceof AccountServiceError && error.code === "identity_in_use") throw new SignInError("in_use", "That sign-in already belongs to another account");
    throw error;
  }
  if (options.bearer === undefined) await options.store.set("session", session);
  return session;
}

/**
 * Finishes the sign-in `started` began, from what came back: a return naming another sign-in's
 * state (an older one, or one never started here) is refused before anything is consumed, and the
 * sign-in this call started is dropped whatever the outcome, so it cannot be finished later.
 */
export async function finishOwnSignIn(started: string, back: string, options: FinishOptions): Promise<AccountSession> {
  const state = new URL(started).searchParams.get("state") ?? "";
  const returned = signInReturn(back);
  if (returned === null || returned.state !== state) {
    await options.store.update("pending", (current) => {
      if (current?.[state] === undefined) return current;
      const { [state]: _dropped, ...rest } = current;
      return rest;
    });
    throw new SignInError("no_sign_in", "This return is not for the sign-in started here");
  }
  return finishSignIn(returned, options);
}
