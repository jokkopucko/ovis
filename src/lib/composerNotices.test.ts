import { expect, it } from "bun:test";
import { arrangeNotices, dismissNotice, isDismissible, NO_DISMISSALS, settleDismissed, type ComposerNotice } from "./composerNotices.ts";

const held: ComposerNotice = { id: "local:1:held", priority: "urgent", revision: "" };
const stream: ComposerNotice = { id: "local:1:output", priority: "urgent", revision: "The output stream failed" };
const draft: ComposerNotice = { id: "local:1:draft", priority: "activity", revision: "ls -la" };
const copied: ComposerNotice = { id: "local:1:clipboard", priority: "notice", revision: "copied to clipboard" };

it("stands the plain notice at the top, the urgent ones under it and the activity on the card", () => {
  expect(arrangeNotices([draft, held, copied], NO_DISMISSALS)).toEqual([copied, held, draft]);
});

it("keeps the given order within one rank", () => {
  expect(arrangeNotices([held, stream], NO_DISMISSALS)).toEqual([held, stream]);
  expect(arrangeNotices([stream, held], NO_DISMISSALS)).toEqual([stream, held]);
});

it("leaves a dismissed notice out while it says the same thing", () => {
  const dismissed = dismissNotice(NO_DISMISSALS, held);
  expect(arrangeNotices([held, draft], dismissed)).toEqual([draft]);
  const reworded = { ...held, revision: "take over" };
  expect(arrangeNotices([reworded, draft], dismissed)).toEqual([reworded, draft]);
  const otherPane = { ...held, id: "local:2:held" };
  expect(arrangeNotices([otherPane], dismissed)).toEqual([otherPane]);
});

it("forgets a dismissal once its notice is gone or reworded, and keeps the map while nothing changed", () => {
  const dismissed = dismissNotice(dismissNotice(NO_DISMISSALS, held), copied);
  expect(settleDismissed(dismissed, [held, copied, draft])).toBe(dismissed);
  const copyGone = settleDismissed(dismissed, [held, draft]);
  expect(copyGone).not.toBe(dismissed);
  expect([...copyGone.keys()]).toEqual([held.id]);
  const heldReworded = settleDismissed(dismissed, [{ ...held, revision: "take over" }, copied]);
  expect([...heldReworded.keys()]).toEqual([copied.id]);
  expect(settleDismissed(dismissed, []).size).toBe(0);
});

it("never dismisses an activity: it holds the user's input", () => {
  expect(isDismissible(draft)).toBe(false);
  expect(isDismissible(held)).toBe(true);
  const after = dismissNotice(NO_DISMISSALS, draft);
  expect(after).toBe(NO_DISMISSALS);
  expect(arrangeNotices([draft], after)).toEqual([draft]);
  const forced = new Map([[draft.id, draft.revision]]);
  expect(arrangeNotices([draft, held], forced)).toEqual([held, draft]);
});

it("a dismissal never changes the map it was given", () => {
  const before = dismissNotice(NO_DISMISSALS, held);
  const after = dismissNotice(before, copied);
  expect(before.has(copied.id)).toBe(false);
  expect(after.has(held.id)).toBe(true);
  expect(after.has(copied.id)).toBe(true);
  expect(NO_DISMISSALS.size).toBe(0);
});
