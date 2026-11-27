import { expect, test } from "bun:test";
import { MIGRATE_TIME_SCALE_ENV, MIGRATE_TIME_SCALE_MAX, migrateTimeScale } from "./migrate-time.ts";

test("a staging run's factor is a whole number up to a day in a second, and never against the production account service", () => {
  const staging = "https://account-staging.test";
  expect([migrateTimeScale(staging, "60"), migrateTimeScale(staging, "1"), migrateTimeScale(staging, String(MIGRATE_TIME_SCALE_MAX))]).toEqual([60, 1, 86_400]);
  expect(migrateTimeScale("https://account.ovis.sh", "60")).toBe(1);
  expect(migrateTimeScale(null, "60")).toBe(1);
  for (const odd of ["", "0", "-5", "1.5", "60s", "086400", "86401", "1e3", " 60"]) expect(migrateTimeScale(staging, odd)).toBe(1);
});

test("with the variable unset, there is no factor, whatever the runner's own environment held", () => {
  const was = process.env[MIGRATE_TIME_SCALE_ENV];
  delete process.env[MIGRATE_TIME_SCALE_ENV];
  try { expect(migrateTimeScale("https://account-staging.test")).toBe(1); } finally { if (was !== undefined) process.env[MIGRATE_TIME_SCALE_ENV] = was; }
});
