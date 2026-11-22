import type { Translate } from "../lib/i18n.ts";
import { TYPED_CODE_FAILURES, type TypedCodeFailure } from "../../shared/relay-code-offer.ts";

export type { TypedCodeFailure };

export function typedCodeFailure(code: string | null): TypedCodeFailure | null {
  const failure = code?.startsWith("typed_code_") ? code.slice("typed_code_".length) : null;
  return TYPED_CODE_FAILURES.find((known) => known === failure) ?? null;
}

export function codeFailureText(t: Translate, failure: TypedCodeFailure): string {
  switch (failure) {
    case "not-a-code": return t("A code has ten letters and digits, like 7K3QD-M2XHA.");
    case "no-pc": return t("No PC shows this code. Check it, or show a new one on the PC.");
    case "wrong": return t("That code did not work. Check it and try again; after three wrong tries the PC needs a new code.");
    case "expired": return t("That code ran out. Show a new one on the PC.");
    case "busy": return t("Another device is trying this code, or it was tried too often. Wait a moment, or show a new code on the PC.");
    case "forged": return t("The answer did not come from a PC this app can pair with. Show a new code on the PC, or scan its QR code.");
    default: return t("The relay could not be reached. Check this device's connection, then try again.");
  }
}
