import { describe, expect, test } from "bun:test";
import { paneTokenRuleMatches, paneTokenValues, type AgentRowTokens } from "./pane-tokens.ts";

describe("paneTokenValues", () => {
  const tokens = { quota: "5h 95% · Wk 67%", summary: "reviewing auth", progress: "40% 12m" };

  test("without herdr rows every token is drawn, by name, so the order does not follow herdr's map", () => {
    expect(paneTokenValues(null, "claude", tokens)).toEqual(["40% 12m", "5h 95% · Wk 67%", "reviewing auth"]);
    expect(paneTokenValues(null, "claude", { progress: "40% 12m", quota: "5h 95% · Wk 67%" })).toEqual(paneTokenValues(null, "claude", { quota: "5h 95% · Wk 67%", progress: "40% 12m" }));
    expect(paneTokenValues({ rows: null, by_agent: {} }, "claude", tokens)).toHaveLength(3);
  });

  test("a missing, blank or non-text token says nothing; a pane without tokens draws none", () => {
    expect(paneTokenValues(null, null, { a: "", b: "   ", c: 3, d: null, e: " kept " })).toEqual(["kept"]);
    expect(paneTokenValues(null, null, undefined)).toEqual([]);
    expect(paneTokenValues({ rows: [{ name: "quota" }], by_agent: {} }, null, {})).toEqual([]);
  });

  test("without herdr rows the background tag is not drawn, where rows that name it draw it", () => {
    expect(paneTokenValues(null, null, { role: " Background ", quota: "5h 95%" })).toEqual(["5h 95%"]);
    expect(paneTokenValues(null, null, { role: "lead" })).toEqual(["lead"]);
    expect(paneTokenValues({ rows: [{ name: "role" }], by_agent: {} }, null, { role: "background" })).toEqual(["background"]);
  });

  test("herdr's rows choose the tokens and their order; an agent's own rows replace them", () => {
    const layout: AgentRowTokens = { rows: [{ name: "summary" }, { name: "quota" }, { name: "summary" }], by_agent: { codex: [{ name: "progress" }] } };
    expect(paneTokenValues(layout, "claude", tokens)).toEqual(["reviewing auth", "5h 95% · Wk 67%"]);
    expect(paneTokenValues(layout, null, tokens)).toEqual(["reviewing auth", "5h 95% · Wk 67%"]);
    expect(paneTokenValues(layout, "codex", tokens)).toEqual(["40% 12m"]);
    expect(paneTokenValues(layout, "constructor", tokens)).toEqual(["reviewing auth", "5h 95% · Wk 67%"]);
    // rows that name no token draw none, as herdr's would
    expect(paneTokenValues({ rows: [], by_agent: {} }, "claude", tokens)).toEqual([]);
    expect(paneTokenValues({ rows: null, by_agent: { codex: [] } }, "claude", tokens)).toHaveLength(3);
  });

  test("the first rule that matches decides: one that hides takes the token off, any other keeps it", () => {
    const layout: AgentRowTokens = {
      rows: [{ name: "quota", rules: [{ starts_with: "5h", hide: false }, { contains: "%", hide: true }] }, { name: "load", rules: [{ gt: 80, hide: true }] }],
      by_agent: {},
    };
    expect(paneTokenValues(layout, null, { quota: "5h 95%", load: "90" })).toEqual(["5h 95%"]);
    expect(paneTokenValues(layout, null, { quota: "Wk 67%", load: "60" })).toEqual(["60"]);
    expect(paneTokenValues(layout, null, { quota: "unknown", load: "90%" })).toEqual(["unknown", "90%"]);
  });

  test("a token the rows name twice is said once, at the first place whose rules leave it shown", () => {
    const layout: AgentRowTokens = {
      rows: [{ name: "quota", rules: [{ equals: "unknown", hide: true }] }, { name: "progress" }, { name: "quota" }],
      by_agent: {},
    };
    // hidden at its first place, shown at its second, as herdr tests each place on its own
    expect(paneTokenValues(layout, null, { quota: "unknown", progress: "40% 12m" })).toEqual(["40% 12m", "unknown"]);
    expect(paneTokenValues(layout, null, { quota: "5h 95%", progress: "40% 12m" })).toEqual(["5h 95%", "40% 12m"]);
  });
});

describe("paneTokenRuleMatches", () => {
  test("text conditions are case-sensitive unless ignore_case, and that folds ASCII letters only", () => {
    expect(paneTokenRuleMatches({ equals: "Local" }, "Local")).toBe(true);
    expect(paneTokenRuleMatches({ equals: "Local" }, "local")).toBe(false);
    expect(paneTokenRuleMatches({ equals: "Local", ignore_case: true }, "LOCAL")).toBe(true);
    expect(paneTokenRuleMatches({ equals: "Ä", ignore_case: true }, "ä")).toBe(false);
    expect(paneTokenRuleMatches({ contains: "WK", ignore_case: true }, "5h 95% · Wk 67%")).toBe(true);
    expect(paneTokenRuleMatches({ starts_with: "Reviewer #" }, "Reviewer #2")).toBe(true);
    expect(paneTokenRuleMatches({ equals: "" }, "x")).toBe(false);
    expect(paneTokenRuleMatches({ contains: "" }, "x")).toBe(true);
    expect(paneTokenRuleMatches({ starts_with: "" }, "x")).toBe(true);
  });

  test("gt and lt compare whole finite numbers only, strictly", () => {
    expect(paneTokenRuleMatches({ gt: 80 }, "90")).toBe(true);
    expect(paneTokenRuleMatches({ gt: 80 }, "80")).toBe(false);
    expect(paneTokenRuleMatches({ lt: 50 }, "4.5e1")).toBe(true);
    expect(paneTokenRuleMatches({ lt: 1 }, ".5")).toBe(true);
    expect(paneTokenRuleMatches({ gt: 0 }, "+3")).toBe(true);
    for (const value of ["90%", " 90", "90 ", "NaN", "inf", "Infinity", "1e999", "", "0x10"]) expect(paneTokenRuleMatches({ gt: -1e300 }, value)).toBe(false);
  });

  test("a rule without a condition matches nothing", () => {
    expect(paneTokenRuleMatches({ hide: true }, "anything")).toBe(false);
  });
});
