/**
 * What an agent's tool does in one of its tabs (browserBroker.ts): read the page, click and type.
 * The page is read from its accessibility tree through the app's own in-process debugger of that
 * tab (browserAxTree.ts, no port), and a ref names an element by its DOM node, so the page's
 * scripts can neither see nor forge one. A field's value is never read, a password's included.
 * A click or typing is done on the element as the page's own script would: a tab no person looks
 * at is not drawn, and a tab that is not drawn takes no input events, so a page sees untrusted
 * events (`isTrusted` false), which a few sites refuse.
 */
import type { WebContents } from "electron";
import { walkTree, type AXNode, type SnapshotEntry } from "./browserAxTree.ts";

const MAX_ITEMS = 400;
/** each tab's refs from its latest snapshot: the DOM node each one names */
const refsOf = new WeakMap<WebContents, Map<string, number>>();

async function send<T>(contents: WebContents, method: string, params?: object): Promise<T> {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  return contents.debugger.sendCommand(method, params) as Promise<T>;
}

export async function snapshot(contents: WebContents, address: string): Promise<string> {
  await send(contents, "Accessibility.enable");
  const { nodes } = await send<{ nodes: AXNode[] }>(contents, "Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const entries: SnapshotEntry[] = [];
  let next = 1;
  if (nodes[0]) walkTree(nodes[0], byId, 0, entries, () => next++);
  const refs = new Map<string, number>();
  const lines = [`Address: ${address}`, `Title: ${contents.getTitle()}`];
  for (const entry of entries.slice(0, MAX_ITEMS)) {
    if (entry.ref) refs.set(entry.ref, entry.backendDOMNodeId);
    lines.push(`${"  ".repeat(Math.min(entry.depth, 8))}${entry.ref ? `${entry.ref} ` : ""}${entry.role} ${JSON.stringify(entry.name.slice(0, 120))}`);
  }
  if (entries.length > MAX_ITEMS) lines.push("(more elements left out)");
  refsOf.set(contents, refs);
  return lines.join("\n");
}

/**
 * Runs `fn` (a function's source, one of this file's) on the element a ref names; false when the latest snapshot
 * holds no such element any more, or `may()` says no once it is found (the person took the tab meanwhile).
 */
async function onRef(contents: WebContents, ref: string, may: () => boolean, fn: string, args: unknown[] = []): Promise<boolean> {
  const node = refsOf.get(contents)?.get(ref);
  if (node === undefined || node === 0) return false;
  let objectId: string | undefined;
  try {
    ({ object: { objectId } } = await send<{ object: { objectId?: string } }>(contents, "DOM.resolveNode", { backendNodeId: node }));
    if (objectId === undefined || !may()) return false;
    const { result } = await send<{ result: { value?: unknown } }>(contents, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
    return result.value === true;
  } catch {
    return false;
  } finally {
    // only this call's own object: another call on the same tab may still be using its own
    if (objectId !== undefined && !contents.isDestroyed() && contents.debugger.isAttached()) void contents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

const CLICK = `function () { if (!this.isConnected) return false; this.scrollIntoView({ block: "center", inline: "center" }); if (typeof this.focus === "function") this.focus(); this.click(); return true; }`;

/** sets the value through the element's own setter, so a page that tracks it (React) sees the change */
const TYPE = `function (text, submit) {
  if (!this.isConnected) return false;
  this.scrollIntoView({ block: "center" });
  this.focus();
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value").set.call(this, text);
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (this.isContentEditable) {
    document.getSelection()?.selectAllChildren(this);
    document.execCommand("insertText", false, text);
  } else return false;
  if (submit) {
    const enter = { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true };
    const go = this.dispatchEvent(new KeyboardEvent("keydown", enter));
    this.dispatchEvent(new KeyboardEvent("keyup", enter));
    if (go && this.form) this.form.requestSubmit();
  }
  return true;
}`;

export function clickRef(contents: WebContents, ref: string, may: () => boolean): Promise<boolean> {
  return onRef(contents, ref, may, CLICK);
}

export function typeRef(contents: WebContents, ref: string, text: string, submit: boolean, may: () => boolean): Promise<boolean> {
  return onRef(contents, ref, may, TYPE, [text, submit]);
}
