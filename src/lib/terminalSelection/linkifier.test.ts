import { expect, mock, test } from "bun:test";
import { terminal } from "./fixture.test-support.ts";
import { createLinkifier, createSelection, type ILink, type ILinkProvider, type LinkUnderline } from "./index.ts";

const range = { start: { x: 2, y: 1 }, end: { x: 5, y: 1 } };
function fixture(links: ILink[]) {
  const term = terminal();
  const linkifier = createLinkifier(term.host);
  linkifier.registerLinkProvider({ provideLinks: (y, reply) => reply(y === 1 ? links : undefined) });
  return { ...term, linkifier };
}

test("hover shows a pointer and a viewport-relative underline, and leave removes both", () => {
  const hover = mock();
  const leave = mock();
  const { host, mouse, linkifier } = fixture([{ range, text: "link", activate: () => {}, hover, leave }]);
  const underlines: (LinkUnderline | null)[] = [];
  linkifier.onUnderlineChange((underline) => underlines.push(underline));
  try {
    mouse("mousemove", [22, 3], { buttons: 0 });
    expect(host.screen.classList.contains("xterm-cursor-pointer")).toBe(true);
    expect(underlines).toEqual([{ start: [1, 0], end: [5, 0] }]);
    expect(hover.mock.calls.map(([, text]) => text)).toEqual(["link"]);

    mouse("mouseleave", [110, 3], { bubbles: false, buttons: 0 });
    expect(host.screen.classList.contains("xterm-cursor-pointer")).toBe(false);
    expect(underlines.at(-1)).toBeNull();
    expect(leave.mock.calls.map(([, text]) => text)).toEqual(["link"]);
  } finally { linkifier.dispose(); }
});

test.each([
  { moved: false, texts: ["link"] },
  { moved: true, texts: [] },
] satisfies { moved: boolean; texts: string[] }[])("activates only a click, not a press that moved=$moved before returning to its starting cell", ({ moved, texts }) => {
  const activate = mock();
  const { mouse, linkifier } = fixture([{ range, text: "link", activate }]);
  try {
    mouse("mousemove", [22, 3], { buttons: 0 });
    mouse("mousedown", [22, 3]);
    if (moved) {
      mouse("mousemove", [42, 3]);
      mouse("mousemove", [22, 3]);
    }
    mouse("mouseup", [22, 3]);
    expect(activate.mock.calls.map(([, text]) => text)).toEqual(texts);
  } finally { linkifier.dispose(); }
});

test("uses the hovered buffer row and shows the visible part of a wrapped link", () => {
  const { host, mouse } = terminal(["history", "alpha beta", "0123456789", "abcdefghij"], { viewport: 1, wrapped: [1] });
  const linkifier = createLinkifier(host);
  const asks: number[] = [];
  const underlines: (LinkUnderline | null)[] = [];
  linkifier.onUnderlineChange((underline) => underlines.push(underline));
  linkifier.registerLinkProvider({
    provideLinks(y, reply) {
      asks.push(y);
      reply([{ range: { start: { x: 9, y: 1 }, end: { x: 4, y: 2 } }, text: "wrapped", activate: () => {} }]);
    },
  });
  try {
    mouse("mousemove", [22, 3], { buttons: 0 });
    mouse("mousemove", [32, 3], { buttons: 0 });
    expect(asks).toEqual([2]);
    expect(underlines).toEqual([{ start: [0, 0], end: [4, 0] }]);
  } finally { linkifier.dispose(); }
});

test("suppresses overlapping lower-priority links and disposes a reply for a row the pointer already left", () => {
  const { host, mouse } = terminal();
  const linkifier = createLinkifier(host);
  type Reply = Parameters<ILinkProvider["provideLinks"]>[1];
  const replies = new Map<number, Reply>();
  const stale = mock();
  const lowHover = mock();
  linkifier.registerLinkProvider({ provideLinks: (y, reply) => { replies.set(y, reply); } });
  linkifier.registerLinkProvider({
    provideLinks: (y, reply) => reply([{
      range: { start: { x: 2, y }, end: { x: 8, y } }, text: "lower", activate: () => {}, hover: lowHover,
    }]),
  });
  try {
    mouse("mousemove", [72, 3], { buttons: 0 });
    mouse("mousemove", [72, 23], { buttons: 0 });
    replies.get(1)?.([{ range, text: "stale", activate: () => {}, dispose: stale }]);
    replies.get(2)?.([{ range: { start: { x: 2, y: 2 }, end: { x: 5, y: 2 } }, text: "higher", activate: () => {} }]);
    expect([stale.mock.calls.length, lowHover.mock.calls.length]).toEqual([1, 0]);
    expect(linkifier.focusedLink()).toBeUndefined();
  } finally { linkifier.dispose(); }
});

test("a pending provider reply uses the newest cell on the row", () => {
  const { host, mouse } = terminal();
  const linkifier = createLinkifier(host);
  let reply: Parameters<ILinkProvider["provideLinks"]>[1] | undefined;
  linkifier.registerLinkProvider({ provideLinks: (_, callback) => { reply = callback; } });
  try {
    mouse("mousemove", [2, 3], { buttons: 0 });
    mouse("mousemove", [22, 3], { buttons: 0 });
    reply?.([{ range, text: "link", activate: () => {} }]);
    expect(linkifier.focusedLink()?.text).toBe("link");
  } finally { linkifier.dispose(); }
});

test("refreshing after an alternate-screen switch does not activate the old pressed link", () => {
  const activate = mock();
  const { mouse, reporting, linkifier } = fixture([{ range, text: "same address", activate }]);
  try {
    mouse("mousemove", [22, 3], { buttons: 0 });
    mouse("mousedown", [22, 3]);
    reporting.alternate = true;
    linkifier.refresh();
    mouse("mouseup", [22, 3]);
    expect(activate.mock.calls).toEqual([]);
  } finally { linkifier.dispose(); }
});

test("link decorations update while hovered and registration disposal clears the affordance", () => {
  const { host, mouse } = terminal();
  const linkifier = createLinkifier(host);
  const link: ILink = { range, text: "name", decorations: { pointerCursor: false, underline: false }, activate: () => {} };
  const changes: (LinkUnderline | null)[] = [];
  linkifier.onUnderlineChange((underline) => changes.push(underline));
  const registration = linkifier.registerLinkProvider({ provideLinks: (_, reply) => reply([link]) });
  try {
    mouse("mousemove", [22, 3], { buttons: 0 });
    expect(host.screen.classList.contains("xterm-cursor-pointer")).toBe(false);
    if (link.decorations) {
      link.decorations.pointerCursor = true;
      link.decorations.underline = true;
    }
    expect(host.screen.classList.contains("xterm-cursor-pointer")).toBe(true);
    expect(changes).toEqual([{ start: [1, 0], end: [5, 0] }]);
    registration.dispose();
    expect(changes.at(-1)).toBeNull();
    expect(host.screen.classList.contains("xterm-cursor-pointer")).toBe(false);
  } finally { linkifier.dispose(); }
});

test("double-click selects an entire focused link instead of just its first word", () => {
  const { host, mouse, click, linkifier } = fixture([{
    range: { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } }, text: "alpha beta", activate: () => {},
  }]);
  const selection = createSelection({ ...host, focusedLink: linkifier.focusedLink });
  try {
    mouse("mousemove", [22, 3], { buttons: 0 });
    click([22, 3], { detail: 2 });
    expect(selection.getSelection()).toBe("alpha beta");
  } finally { selection.dispose(); linkifier.dispose(); }
});
