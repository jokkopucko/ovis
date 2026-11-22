import { expect, test } from "bun:test";
import { withRowDrop, type RowDrop } from "./row-drop-evidence.ts";

const pending: RowDrop = { row: "row-1", admit_no: 4, how: "remove" };

test("P8/T41/P10: a journalled drop of another reason never replaces the pending reason of the same admission", () => {
  const doc = { row_drops: [pending] };
  expect(withRowDrop(doc, { row: "row-1", admit_no: 4, how: "revoke_all", journalled: 9 }).row_drops).toEqual([pending]);
});

test("P8/T41/P10: the journal seq marks the same admission's own reason", () => {
  expect(withRowDrop({ row_drops: [pending] }, { ...pending, journalled: 9 }).row_drops).toEqual([{ ...pending, journalled: 9 }]);
});
