/**
 * Signing in with GitHub, Google or Apple through the account service: OAuth's authorization code with
 * PKCE, the service standing between this client and the provider. The service sends the browser
 * back with the code in the fragment, which no request carries, so the code never reaches the
 * host that serves the app.
 */
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { AccountHintError, isEmailHintProvider, type SignInCreation } from "./accountHint.ts";
import { AccountService, AccountServiceError, requestToken, SignedOutError } from "./service.ts";
import type { AccountProvider, AccountSession, AccountStore, LinkSignIn, PendingPairing, PendingSignIn, ResumeAdd } from "./store.ts";

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
export async function beginSignIn(provider: AccountProvider, options: { store: AccountStore; service: string; redirectUri: string | (() => Promise<string>); now?: () => number; linkToken?: string; link?: LinkSignIn; pairing?: PendingPairing; pc?: string; signOutEverywhere?: string; generation?: string; resumeAdd?: ResumeAdd } & (SignInCreation | { readonly create?: undefined })): Promise<string> {
  let creation = isEmailHintProvider(provider) && options.linkToken === undefined && options.link === undefined
    && options.resumeAdd === undefined && options.signOutEverywhere === undefined ? options : undefined;
  let connectEpoch: string | undefined;
  const generation = options.generation ?? await AccountService.signInGeneration(options.store);
  if (creation?.create === "never") {
    const proposed = crypto.randomUUID();
    await options.store.updateMany(["session", "generation", "connect_epoch"], (current) => {
      if (current.session !== undefined || current.generation !== generation) return current;
      connectEpoch = current.connect_epoch ?? proposed;
      return { ...current, connect_epoch: connectEpoch };
    });
    if (connectEpoch === undefined) throw new SignedOutError();
  }
  const redirectUri = typeof options.redirectUri === "string" ? options.redirectUri : await options.redirectUri();
  if (creation?.create === "ask" && await options.store.get("session") !== undefined) creation = undefined;
  const verifier = random(32);
  const state = random(16);
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const now = (options.now ?? Date.now)();
  const pending: PendingSignIn = { service: options.service, provider, state, verifier, redirect_uri: redirectUri, started_at: now, generation, ...(options.pairing ? { pairing: options.pairing } : {}), ...(options.pc ? { pc: options.pc } : {}),
    ...(options.signOutEverywhere ? { sign_out_everywhere: options.signOutEverywhere } : {}), ...(options.link ? { link: options.link } : {}),
    ...(creation?.create === "ask" ? { create: "ask" } : creation?.create === "never" && connectEpoch !== undefined ? { then_add: creation.thenAdd, connect_epoch: connectEpoch } : {}),
    ...(options.resumeAdd ? { resume_add: options.resumeAdd } : {}) };
  // one per state: another tab's sign-in stays, and only ones past their time are dropped
  await options.store.update("pending", (current) => ({
    ...Object.fromEntries(Object.entries(current ?? {}).filter(([, waiting]) => now - waiting.started_at <= SIGN_IN_MS)),
    [state]: pending,
  }));
  const url = new URL(`/v1/signin/${provider}`, options.service);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.linkToken !== undefined) url.searchParams.set("link_token", options.linkToken);
  if (creation?.create !== undefined) url.searchParams.set("create", creation.create);
  return url.href;
}

export type SignInReturn = { code: string; state: string } | { error: string; state: string; existingProvider?: AccountProvider };

export function signInReturn(params: string): SignInReturn | null {
  const fields = new URLSearchParams(params.replace(/^[#?]/, ""));
  const state = fields.get("state");
  if (state === null) return null;
  const code = fields.get("code");
  if (code !== null) return { code, state };
  const error = fields.get("error");
  const existingProvider = fields.get("existing_provider");
  return error === null ? null : { error, state, ...(error === "existing_account" && (existingProvider === "apple" || isEmailHintProvider(existingProvider)) ? { existingProvider } : {}) };
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
  readonly wantedAtInstall?: () => boolean;
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

/** Trades the code of a sign-in already taken. Only the web link return supplies `linkService` to install its answer. */
export async function redeemSignIn(pending: PendingSignIn | undefined, returned: SignInReturn, options: FinishOptions & { readonly linkService?: AccountService }): Promise<AccountSession> {
  const now = options.now ?? Date.now;
  if (pending === undefined) throw new SignInError("no_sign_in", "This sign-in was not started here, or has finished");
  if (now() - pending.started_at > SIGN_IN_MS) throw new SignInError("expired", "The sign-in took too long");
  const linking = pending.link !== undefined || options.bearer !== undefined;
  if ("error" in returned) {
    const provider = pending.provider;
    if (!linking && isEmailHintProvider(provider)) {
      if (pending.create === "ask" && returned.error === "existing_account" && returned.existingProvider !== undefined && returned.existingProvider !== provider) {
        if (pending.generation !== undefined) await AccountService.checkGeneration(options.store, pending.generation);
        throw new AccountHintError({ provider, existingProvider: returned.existingProvider, noAccount: false });
      }
      if (pending.then_add !== undefined && returned.error === "no_account") {
        if (pending.generation !== undefined) await AccountService.checkGeneration(options.store, pending.generation);
        if (pending.connect_epoch === undefined || await options.store.get("connect_epoch") !== pending.connect_epoch) throw new SignedOutError();
        throw new AccountHintError({ provider: pending.then_add, existingProvider: provider, noAccount: true });
      }
    }
    if (returned.error === "invalid_link") throw new SignInError("expired", "The link to add a sign-in method ran out");
    if (linking && returned.error === "identity_in_use") throw new SignInError("in_use", "That sign-in already belongs to another account");
    if (linking && ["identity_exists", "reauth_required", "two_step_required", "two_step_unknown", "merge_open"].includes(returned.error)) {
      throw new AccountServiceError(400, returned.error, "The sign-in method was refused");
    }
    throw new SignInError("denied", "The sign-in was cancelled or refused");
  }
  // A pending record is consumed once. A previous build did not stamp it, so adopt the generation now.
  const generation = pending.generation ?? await AccountService.signInGeneration(options.store);
  await AccountService.checkGeneration(options.store, generation);
  let before: AccountSession | undefined;
  if (pending.link !== undefined) {
    before = await options.store.get("session");
    if (before?.account !== pending.link.account || before.sign_in_id !== pending.link.sign_in_id || before.service !== pending.service) throw new SignedOutError();
    before = await (options.linkService ?? new AccountService(options)).refreshSignIn({ generation, session: before });
  }
  const bearer = before?.access_token ?? options.bearer;
  let session: AccountSession;
  try {
    session = await requestToken(pending.service, {
      grant_type: "authorization_code", code: returned.code, code_verifier: pending.verifier, redirect_uri: pending.redirect_uri,
    }, { ...(options.fetch ? { fetch: options.fetch } : {}), now, ...(bearer === undefined ? {} : { bearer }) });
  } catch (error) {
    await AccountService.checkGeneration(options.store, generation);
    if (error instanceof AccountServiceError && error.code === "identity_in_use") throw new SignInError("in_use", "That sign-in already belongs to another account");
    if (linking && error instanceof AccountServiceError && error.code === "invalid_link") throw new SignInError("expired", "The link to add a sign-in method ran out");
    throw error;
  }
  const issued = await finishIssuedSignIn(session, generation, {
    ...options, ...(bearer === undefined ? {} : { bearer }),
    ...(pending.then_add === undefined ? {} : { connectEpoch: pending.connect_epoch ?? null }),
  });
  return before === undefined || options.linkService === undefined ? issued
    : options.linkService.installMethodLink({ generation, session: before }, issued);
}

/** A link is installed by addMethod; other sign-ins are installed atomically against the generation. */
export async function finishIssuedSignIn(issued: AccountSession, generation: string, options: FinishOptions & { readonly connectEpoch?: string | null }): Promise<AccountSession> {
  const session = { ...issued, sign_in_generation: generation };
  const kept = options.bearer !== undefined || await AccountService.storeSignIn(options.store, session, {
    ...(options.wantedAtInstall === undefined ? {} : { wanted: options.wantedAtInstall }),
    ...(options.connectEpoch === undefined ? {} : { connectEpoch: options.connectEpoch }),
  });
  if (kept && await options.store.get("generation") === generation) return session;
  await AccountService.revokeSession(session, options);
  throw new SignedOutError();
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
    await takePendingSignIn(options.store, state);
    throw new SignInError("no_sign_in", "This return is not for the sign-in started here");
  }
  return finishSignIn(returned, options);
}
