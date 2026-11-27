import { isIsoTime } from "../../../shared/account-records.ts";
import { ACCOUNT_PROVIDERS, type AccountProvider } from "./store.ts";

/** One way the account signs in; the service keeps no email or login to name it by. */
export interface AccountIdentity {
  readonly provider: AccountProvider;
  readonly added_at: string;
}

export interface AccountIdentityChange {
  readonly kind: "add" | "remove" | "merge_in";
  readonly provider: AccountProvider;
  readonly at: string;
  readonly device_no: number | null;
}

export interface AccountIdentityList {
  readonly identities: AccountIdentity[];
  readonly history: AccountIdentityChange[];
}

export function identityAnswer(body: unknown): AccountIdentityList {
  const answer = typeof body === "object" && body !== null ? body : {};
  const identities: readonly unknown[] = "identities" in answer && Array.isArray(answer.identities) ? answer.identities : [];
  const history: readonly unknown[] = "history" in answer && Array.isArray(answer.history) ? answer.history : [];
  return {
    identities: identities.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("provider" in entry) || !("added_at" in entry)) return [];
      const provider = ACCOUNT_PROVIDERS.find((each) => each === entry.provider);
      return provider !== undefined && typeof entry.added_at === "string" ? [{ provider, added_at: entry.added_at }] : [];
    }),
    history: history.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("kind" in entry) || !("provider" in entry) || !("at" in entry) || !("device_no" in entry)) return [];
      const { kind, at, device_no } = entry;
      const provider = ACCOUNT_PROVIDERS.find((each) => each === entry.provider);
      if (provider === undefined || (kind !== "add" && kind !== "remove" && kind !== "merge_in")) return [];
      if (typeof at !== "string" || !isIsoTime(at)) return [];
      if (device_no !== null && (typeof device_no !== "number" || !Number.isSafeInteger(device_no) || device_no < 1)) return [];
      return [{ kind, provider, at, device_no }];
    }),
  };
}
