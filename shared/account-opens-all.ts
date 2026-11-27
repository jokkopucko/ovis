export const OVIS_ACCOUNT_OPENS_ALL = "OVIS_ACCOUNT_OPENS_ALL";

/** Also read by the dependency-free launcher before it adopts a legacy state directory. */
export function accountOpensAll(value = process.env[OVIS_ACCOUNT_OPENS_ALL]): boolean {
  return value !== "0";
}
