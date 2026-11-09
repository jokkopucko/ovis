import { describe, expect, it } from "bun:test";

import { openGroupItems } from "./moreMenu.ts";

const find = [{ id: "find", divider: true }, { id: "search-conversation" }];
const pane = [{ id: "rename", divider: true }, { id: "close-tab", divider: true }];

describe("the open More group's items", () => {
  it("lists the group's items at a phone's width, the first without a hairline", () => {
    expect(openGroupItems("find", true, find, pane)).toEqual([{ id: "find", divider: false }, { id: "search-conversation" }]);
    expect(openGroupItems("pane", true, find, pane)).toEqual([{ id: "rename", divider: false }, { id: "close-tab", divider: true }]);
    expect(openGroupItems(null, true, find, pane)).toEqual([]);
  });

  // a window widened while Find… was open: More lists those items itself there, so the group closes
  it("has none once the screen is wider than a phone's", () => {
    expect(openGroupItems("find", false, find, pane)).toEqual([]);
    expect(openGroupItems("pane", false, find, pane)).toEqual([]);
  });
});
