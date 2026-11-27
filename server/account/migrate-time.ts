/**
 * The waits of moving an account onto its signed list, turned down for a staging run (docs/account-list.md, "An
 * account that was in use"): a day and six running hours before a key counts. The rules keep their numbers; this PC
 * multiplies the durations it measures and hands over (to its own check and to the devices that ask it) by
 * OVIS_LIST_MIGRATE_TIME_SCALE. It is honoured only when the account service is not the production one, so it cannot
 * weaken an install that talks to the real service.
 */
import { DEFAULT_ACCOUNT_SERVICE } from "../../shared/web-policy.ts";

export const MIGRATE_TIME_SCALE_ENV = "OVIS_LIST_MIGRATE_TIME_SCALE";
/** The most a staging run may speed the waits up: a day then lasts a second. */
export const MIGRATE_TIME_SCALE_MAX = 86_400;

/** Whether `origin` is the production account service's host, however it is spelled (a trailing dot names the same host). */
function production(origin: string): boolean {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return true; }
  return host.replace(/\.+$/, "") === new URL(DEFAULT_ACCOUNT_SERVICE).hostname;
}

/** The factor in force for a PC whose account service is at `origin` (null: none): 1 unless the variable names a whole number from 1 to MIGRATE_TIME_SCALE_MAX and the service is not production. */
export function migrateTimeScale(origin: string | null, value: string | undefined = process.env[MIGRATE_TIME_SCALE_ENV]): number {
  if (value === undefined || origin === null || production(origin)) return 1;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) return 1;
  const scale = Number(value);
  return scale <= MIGRATE_TIME_SCALE_MAX ? scale : 1;
}
