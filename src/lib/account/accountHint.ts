import type { AccountProvider, EmailHintProvider } from "./store.ts";

export type SignInCreation = { readonly create: "ask" }
  | { readonly create: "never"; readonly thenAdd: EmailHintProvider; readonly wanted?: () => boolean };

export interface AccountHint {
  readonly provider: EmailHintProvider;
  readonly existingProvider: AccountProvider;
  readonly noAccount: boolean;
}

export type AccountHintChoice = "connect" | "create";

export function isEmailHintProvider(provider: string | null): provider is EmailHintProvider {
  return provider === "github" || provider === "google";
}

export class AccountHintError extends Error {
  readonly code: "existing_account" | "no_account";

  constructor(readonly hint: AccountHint) {
    super(hint.noAccount ? "no_account" : "existing_account");
    this.name = "AccountHintError";
    this.code = hint.noAccount ? "no_account" : "existing_account";
  }
}
