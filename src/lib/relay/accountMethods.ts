import { nativeSignIn, nativeSignInAvailable } from "../account/native.ts";
import { AccountService, AccountServiceError, sameSignIn, SignedOutError } from "../account/service.ts";
import { beginSignIn, redeemSignIn, SignInError, takePendingSignIn, type FinishOptions, type SignInReturn } from "../account/signin.ts";
import type { AccountProvider, AccountSession, LinkSignIn, PendingSignIn } from "../account/store.ts";

export interface MethodsChange {
  readonly account: string;
  readonly provider: AccountProvider;
  readonly error: string | null;
  readonly fromHint?: true;
}

type Asked = Omit<MethodsChange, "error">;

export function accountMethods(account: AccountService, options: Pick<FinishOptions, "store" | "fetch"> & {
  readonly service: string | null;
  readonly open: (url: string) => void;
  readonly changed: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly register: (session: AccountSession) => Promise<unknown>;
}) {
  let last: MethodsChange | undefined;
  const record = async (asked: Asked, error: string | null): Promise<MethodsChange> => {
    const result = { ...asked, error };
    last = result;
    await options.changed();
    return result;
  };
  const refused = async (asked: Asked, error: Error): Promise<MethodsChange> => {
    if (error instanceof SignedOutError) await options.refresh();
    const code = error instanceof SignInError || error instanceof AccountServiceError || error instanceof SignedOutError ? error.code : "failed";
    return record(asked, code);
  };
  const change = async (asked: Asked, work: () => Promise<void>): Promise<MethodsChange> => {
    try { await work(); } catch (error) {
      if (error instanceof Error) return refused(asked, error);
      throw error;
    }
    return record(asked, null);
  };
  const stillShown = async (shown: AccountSession): Promise<void> => {
    const current = await options.store.get("session");
    if (current?.account !== shown.account || !sameSignIn(current, shown)) throw new SignedOutError();
  };
  const leaveFor = async (provider: AccountProvider, shown: AccountSession, pending: Pick<Parameters<typeof beginSignIn>[1], "linkToken" | "link" | "pc" | "resumeAdd" | "pairing"> & { readonly generation: string }): Promise<void> => {
    const { store } = options;
    const url = await beginSignIn(provider, { store, service: shown.service, redirectUri: `${window.location.origin}/`, ...pending });
    try {
      await AccountService.checkGeneration(store, pending.generation);
      await stillShown(shown);
    } catch (error) {
      await takePendingSignIn(store, new URL(url).searchParams.get("state") ?? "");
      throw error;
    }
    options.open(url);
  };
  return {
    get last() { return last; },
    methods: (shown: AccountSession) => account.forSignIn(shown).identities(),
    /** True only when the web page is leaving for the provider. */
    async addMethod(provider: AccountProvider, shown: AccountSession, continuation?: Pick<PendingSignIn, "pc" | "pairing"> & { readonly fromHint?: true }): Promise<boolean> {
      const { service, store, fetch } = options;
      if (service === null) return false;
      const { fromHint, ...destination } = continuation ?? {};
      const asked: Asked = { account: shown.account, provider, ...(fromHint ? { fromHint } : {}) };
      const bound = account.forSignIn(shown);
      try {
        const started = await bound.startMethodLink(provider);
        const { linkToken, link, generation, session } = started;
        if (nativeSignInAvailable()) {
          const issued = await nativeSignIn(provider, {
            store, service: session.service, ...(fetch === undefined ? {} : { fetch }), link: { linkToken, link, generation },
          });
          await options.register(await bound.installMethodLink(started, issued));
          await record(asked, null);
          await options.refresh();
          return false;
        }
        await leaveFor(provider, session, { linkToken, link: { ...link, ...(fromHint ? { fromHint } : {}) }, generation, ...destination });
        return true;
      } catch (error) {
        if (error instanceof Error) await refused(asked, error);
        else throw error;
        return false;
      }
    },
    async signInAgain(shown: AccountSession, add: AccountProvider | undefined, pc?: string): Promise<void> {
      const { store, service } = options;
      if (service === null) return;
      const asked = { account: shown.account, provider: add ?? shown.provider };
      try {
        const generation = await AccountService.signInGeneration(store);
        await stillShown(shown);
        await leaveFor(shown.provider, shown, {
          generation,
          ...(pc === undefined ? {} : { pc }), ...(add === undefined ? {} : { resumeAdd: asked }),
        });
      } catch (error) {
        if (error instanceof Error) await refused(asked, error);
        else throw error;
      }
    },
    async removeMethod(provider: AccountProvider, shown: AccountSession): Promise<void> {
      if (options.service === null) return;
      const result = await change({ account: shown.account, provider }, () => account.forSignIn(shown).removeIdentity(provider));
      if (result.error === null) await options.refresh();
    },
    finish(pending: PendingSignIn & { readonly link: LinkSignIn }, returned: SignInReturn): Promise<MethodsChange> {
      const { store, fetch } = options;
      return change({ account: pending.link.account, provider: pending.provider, ...(pending.link.fromHint ? { fromHint: pending.link.fromHint } : {}) }, async () => {
        await options.register(await redeemSignIn(pending, returned, {
          store, ...(fetch === undefined ? {} : { fetch }), linkService: account,
        }));
      });
    },
  };
}
