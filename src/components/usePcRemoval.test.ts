import { describe, expect, it } from "bun:test";
import { translate, type Vars } from "../lib/i18n.ts";
import { ListPcRemovalError, pcRemovalFailure } from "./usePcRemoval.tsx";

const t = (key: string, vars?: Vars): string => translate("en", key, vars);

describe("what a removal that failed says", () => {
  it("says what the list said where that tells the person more, and the surface's own words otherwise", () => {
    expect(pcRemovalFailure(new ListPcRemovalError("stopped"), t, "Desk could not be removed. Try again.")).toBe("The account service cannot change the list right now.");
    // a request signed for an earlier change still waits: nothing was signed for this one
    expect(pcRemovalFailure(new ListPcRemovalError("waiting"), t, "Desk could not be removed. Try again.")).toBe("An earlier change is still waiting: try it again or cancel it first.");
    expect(pcRemovalFailure(new ListPcRemovalError("busy"), t, "Desk could not be removed. Try again.")).toBe("Desk could not be removed. Try again.");
    expect(pcRemovalFailure(new Error("502"), t, "Desk could not be removed. Try again.")).toBe("Desk could not be removed. Try again.");
  });
});
