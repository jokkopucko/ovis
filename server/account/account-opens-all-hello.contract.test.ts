import { afterEach, describe, expect, test } from "bun:test";
import { OVIS_ACCOUNT_OPENS_ALL } from "../../shared/account-devices-api.ts";
import { ACCOUNT_FEATURE, FrameType, ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";

type Fixture = ReturnType<typeof relayFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

async function welcomeFeatures(flag: string | undefined, offered: readonly string[]): Promise<string[]> {
  const saved = process.env[OVIS_ACCOUNT_OPENS_ALL];
  if (flag === undefined) delete process.env[OVIS_ACCOUNT_OPENS_ALL];
  else process.env[OVIS_ACCOUNT_OPENS_ALL] = flag;
  try {
    const f = relayFixture(false, { accountOpensAll: undefined });
  if (flag !== "0") f.app.context.services.devices.bindByService("acct_hello");
    fixtures.push(f);
    const link = await relayConnection(f);
    link.mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [...offered], required_features: [] } });
    return await new Promise<string[]>((resolve) => { link.onFrame = (frame) => { if (frame.type === FrameType.WELCOME) resolve([...frame.payload.features]); }; });
  } finally {
    if (saved === undefined) delete process.env[OVIS_ACCOUNT_OPENS_ALL];
    else process.env[OVIS_ACCOUNT_OPENS_ALL] = saved;
  }
}

describe("S2-25 the account-opens-all mux feature (S25)", () => {
  test("S25: a PC with OVIS_ACCOUNT_OPENS_ALL=1 selects the feature for an app that offers it", async () => {
    expect(await welcomeFeatures("1", [ACCOUNT_FEATURE, ACCOUNT_OPENS_ALL_FEATURE])).toEqual([ACCOUNT_FEATURE, ACCOUNT_OPENS_ALL_FEATURE]);
  });

  test("S25: a PC selects the feature by default for an app that offers it", async () => {
    expect(await welcomeFeatures(undefined, [ACCOUNT_FEATURE, ACCOUNT_OPENS_ALL_FEATURE])).toEqual([ACCOUNT_FEATURE, ACCOUNT_OPENS_ALL_FEATURE]);
  });

  test("S25: an old app's hello, or a PC with the flag off, selects only today's features", async () => {
    expect(await welcomeFeatures("1", [ACCOUNT_FEATURE])).toEqual([ACCOUNT_FEATURE]);
    expect(await welcomeFeatures("0", [ACCOUNT_FEATURE, ACCOUNT_OPENS_ALL_FEATURE])).toEqual([ACCOUNT_FEATURE]);
  });
});
