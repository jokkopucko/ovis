import { describe, expect, test } from "bun:test";
import { listWorld } from "./accountList.test-helpers.ts";
import { AccountServiceError } from "./service.ts";

/** The account service's routes a migration asks, as a device reads them (docs/account-list.md, "An account that was in use"). */
describe("what the account service says to a device of an account that was in use", () => {
  test("an account on no migrate switch is told nothing new: GET /v2/lists/mine says no `migrate`", async () => {
    const world = listWorld();
    const phone = await world.device();
    const said = await phone.service.accountList();
    expect(said).not.toBe("off");
    if (said === "off") return;
    expect(said.hint).toBeNull();
    expect(said.migrate).toBe(false);
  });

  test("an account on the migrate switch with no list is told that it may move", async () => {
    const world = listWorld();
    world.fake.listMigrateAccounts = world.account;
    const phone = await world.device();
    const said = await phone.service.accountList();
    expect(said !== "off" && said.migrate).toBe(true);
  });

  test("GET /v1/devices lists each registered key with whether a PC lets it in, a removed one as removed", async () => {
    const world = listWorld();
    const phone = await world.device({ label: "Phone" });
    const laptop = await world.device({ label: "Laptop" });
    const laptopKey = (await laptop.store.get("signin_key"))!.key.public_spki;
    world.fake.removeDevice(world.account, laptopKey);
    const rows = await phone.service.devices();
    const phoneKey = (await phone.store.get("signin_key"))!.key.public_spki;
    expect(rows.find((row) => row.key === phoneKey)).toEqual({ key: phoneKey, eligible: true, removed: false, label: "Phone" });
    expect(rows.find((row) => row.key === laptopKey)).toEqual({ key: laptopKey, eligible: false, removed: true, label: "Laptop" });
  });

  test("the account service's lie that a removed key is eligible again reaches GET /v1/devices too", async () => {
    const world = listWorld();
    const phone = await world.device();
    const laptop = await world.device({ label: "Laptop" });
    const laptopKey = (await laptop.store.get("signin_key"))!.key.public_spki;
    world.fake.removeDevice(world.account, laptopKey);
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptopKey] });
    const rows = await phone.service.devices();
    expect(rows.find((row) => row.key === laptopKey)).toEqual({ key: laptopKey, eligible: true, removed: false, label: "Laptop" });
  });

  test("a key registered with no name has no `label` in GET /v1/devices, and one out of its form is read as none", async () => {
    const world = listWorld();
    const phone = await world.device();
    const bare = await phone.service.devices();
    expect(bare.every((row) => "label" in row)).toBe(true);
    const raw = await world.fake.fetch(`${world.origin}/v1/devices`, { headers: { authorization: `Bearer ${phone.session.access_token}` } });
    const body = await raw.json() as { devices: { label?: unknown }[] };
    expect(body.devices.every((row) => typeof row.label === "string")).toBe(true);
    world.fake.registerDevice(world.account, (await (await import("./store.ts")).newKey()).public_spki, "");
    const rows = await phone.service.devices();
    expect(rows.filter((row) => row.label === undefined)).toHaveLength(1);
  });

  test("a refusal of a list's request names the place it is about, and a `list_exists` the list it names", async () => {
    const world = listWorld();
    const phone = await world.device();
    const error = await phone.service.startBirth({ entry: "not an entry", entries: ["a", "b"], wraps: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountServiceError);
    expect((error as AccountServiceError).status).toBe(400);
    // the account is on no migrate switch: the service's refusal of a birth for it names entry 1 or entry 0
    expect((error as AccountServiceError).index).not.toBeNull();
  });
});
