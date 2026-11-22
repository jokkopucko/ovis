import type { AccountRow } from "./account-device-state.ts";

/** Carried only by the snapshot pull that the proved sign-in started. */
export type Readmission = (row: AccountRow, account: string) => boolean;
