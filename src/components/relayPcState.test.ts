import { describe, expect, it } from "bun:test";
import { LANGUAGE_SETTINGS, translate, type Language } from "../lib/i18n.ts";
import { askToJoinReason } from "./relayPcState.tsx";

const pc = { added_at: "2026-11-10T03:00:00.000Z", join: { server_public_key: "k", relay: "wss://relay.ovis.sh" } };

describe("askToJoinReason", () => {
  it("gives a listed PC with a route the Join reason's own words in every language, and none to a PC without a route or a listing", () => {
    for (const language of LANGUAGE_SETTINGS.filter((setting): setting is Language => setting !== "system")) {
      const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
      expect(askToJoinReason(pc, t)).toBe(translate(language, "Join · approve on a connected device of your account, or type the number the PC shows"));
    }
    const t = (key: string) => translate("en", key);
    expect(askToJoinReason({ added_at: pc.added_at }, t)).toBeNull();
    expect(askToJoinReason({ ...pc, added_at: null }, t)).toBeNull();
  });
});
