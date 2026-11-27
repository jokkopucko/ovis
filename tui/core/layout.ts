/**
 * The screen's layout writes: herdr's create, close, rename, split, zoom, resize, swap, move and reorder actions,
 * performed through the shared layout operations the server performs the browser's with (server/herdr-core/layout-ops.ts).
 * Every rule of the layout lives there; this module holds only the screen's policy on top:
 * - one write in flight: an action chosen while one is under way is dropped with a notice, never queued;
 * - nothing is sent again: an answer that never came (the line ended, a timeout) is reported as unknown, and the
 *   world shows what the core holds once the line is back;
 * - nothing is drawn ahead: the picture changes only when the core's documents and terminals say so;
 * - a close ends only the terminals the user saw: their addresses and created_ms are read again first.
 */

import type { HcConnection } from "../../server/herdr-core/connection.ts";
import { HcError, HcReplyError } from "../../server/herdr-core/connection.ts";
import { AdapterError } from "../../server/herdr-core/errors.ts";
import { foreignLayout, leaves, OVIS_LAYOUT_DOC, OVIS_LAYOUT_SCHEMA, type PaneDirection, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type CloseTarget, collapseEdit, layoutCalls, LayoutStore, type LayoutView, newLayoutId, ownsLayout, passthroughEdit, readCore, RESIZE_STEP, resizeEdit, swapEdit, TERMINAL_COLOUR, zoomEdit } from "../../server/herdr-core/layout-ops.ts";
import { FIRST_CLAIM_MS } from "../model/deadlines.ts";
import { type CoreHost, type FirstTurn, LAYOUT_DOC, OTHER_WORKSPACE_ID } from "../../server/herdr-core/snapshot.ts";
import { checkoutHolding, factsOf, gitDirIdentity, type Repository, WORKTREE_LABEL, worktreeFolder, worktreeLabel } from "../../server/herdr-core/worktrees.ts";
import type { CheckoutRow } from "../model/overlays.ts";
import { checkoutTop, repositoryFiles } from "./git-head.ts";
import type { OvisServer } from "./ovis-server.ts";
import { suggestWorktreeBranch } from "../../shared/worktree-name.ts";
import { errorCode } from "../crash.ts";
import type { RunEffect, Seen, WorktreeTarget } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";

/** What a layout write tells the screen: a notice (`calm` when it reports how things are, not a failure), or a pane to focus once shown. */
export type LayoutAnswer =
  | { readonly type: "notice"; readonly code: string; readonly data: Readonly<Record<string, string>>; readonly calm?: true }
  | { readonly type: "follow"; readonly target: Target; readonly away: string | null }
  /** a repository's checkouts, read for Open worktree... */
  | { readonly type: "worktrees"; readonly target: Target; readonly checkouts: readonly CheckoutRow[] }
  /** New worktree's dialog: the repository's name and the branch to start with */
  | { readonly type: "new_worktree"; readonly target: Target; readonly repo: string; readonly branch: string; readonly worktree: WorktreeTarget }
  /** Delete worktree checkout...'s question: the checkout's folder */
  | { readonly type: "remove_worktree"; readonly target: Target; readonly worktree: WorktreeTarget };

/** What a layout write did that the screen is still to show: the terminals a close ended (none for any other write). */
export interface LayoutDone {
  readonly ended: readonly string[];
  readonly dropInput?: "layout_unknown" | "not_closed";
  readonly refreshZoom?: true;
  /** The destination this successful create or move established, independent of subsequent focus changes. */
  readonly inputTarget?: string;
}

/**
 * What opening the first workspace did, as a write's answer. `again`: another screen holds the claim to open it, and this
 * one looks again after this long, in case that screen left without opening anything.
 */
export interface FirstDone extends LayoutDone { readonly again?: number }

const NOTHING_ENDED: LayoutDone = { ended: [] };

/** A failed connection or a core reporting that it too lost the answer (for example, on a remote machine). */
function unknownAnswer(error: unknown): boolean {
  return error instanceof HcError && (!(error instanceof HcReplyError) || ["timeout", "offline", "closed"].includes(error.kind));
}

interface LayoutWritesOptions {
  /** the core's line (the screen's link) */
  hc: Pick<HcConnection, "call" | "hello">;
  /** how the screen reads terminals into the snapshot, the same as its world (world.ts `CoreWorld.model`) */
  model: { readonly firstTurn: FirstTurn; readonly host: CoreHost };
  /** the folder the screen was opened in: a new workspace starts there */
  folder: string | undefined;
  /** the user's home: the first workspace opened there is named as herdr's server names its own */
  home?: string | undefined;
  /**
   * the wall clock, in ms, which every screen on this PC reads alike (the loop's own clock is the process's): a
   * first-workspace claim's time is told by it. Unset: the system's
   */
  wall?: (() => number) | undefined;
  answer: (answer: LayoutAnswer) => void;
  /** the Ovis server, for herdr's New worktree and Delete worktree checkout... (git runs there) */
  server: OvisServer;
}

/** What herdr names the first workspace its server opens in its own home; a workspace in any other folder is named after it. */
const HOME_NAME = "~";

/** The layout document's key for the first workspace's claim (`LayoutWrites.claimFirst`): `{ opening: true, until }`. */
const FIRST_CLAIM = "first_workspace";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Until when, by the wall clock, a claim in the layout document holds; null for none, for one past its time, and for one
 * that names no time or a time no claim written by now could have (a clock that ran ahead holds a claim no longer).
 */
function claimedUntil(doc: unknown, now: number): number | null {
  const claim = isRecord(doc) ? doc[FIRST_CLAIM] : undefined;
  const until = isRecord(claim) ? claim["until"] : undefined;
  return typeof until === "number" && until > now && until <= now + FIRST_CLAIM_MS ? until : null;
}

/** A claim this screen wrote: the document without it, and the document's version with it (null once it is not this screen's to take out). */
interface FirstClaim { readonly rest: Record<string, unknown>; version: number | null }

const SPLITS: Readonly<Record<string, SplitDirection>> = { split_vertical: "right", split_horizontal: "down" };
const SWAPS: Readonly<Record<string, PaneDirection>> = { swap_pane_left: "left", swap_pane_down: "down", swap_pane_up: "up", swap_pane_right: "right" };
const RESIZES: Readonly<Record<string, PaneDirection>> = { resize_pane_left: "left", resize_pane_down: "down", resize_pane_up: "up", resize_pane_right: "right" };

/** The core read afresh: the snapshot as the screen shows it, and when the core made each terminal. */
interface Fresh { readonly view: LayoutView; readonly created: ReadonlyMap<string, number> }

/** Whether the terminals a close ends now are exactly the ones the user saw, each made at the time it was shown. */
function sameTerminals(ends: readonly string[], seen: readonly Seen[], created: ReadonlyMap<string, number>): boolean {
  if (ends.length !== seen.length) return false;
  const now = new Set(ends);
  return seen.every((one) => now.has(one.id) && (one.created === null || created.get(one.id) === one.created));
}

/** The place `id` moves to among `ids`, as herdr's insertion boundary: one up or one down; null at that end. */
function oneStep(ids: readonly string[], id: string, down: boolean): number | null {
  const at = ids.indexOf(id);
  if (at < 0 || (down ? at === ids.length - 1 : at === 0)) return null;
  return down ? at + 2 : at - 1;
}

export class LayoutWrites {
  private readonly store: LayoutStore;
  private busy = false;
  private readonly wall: () => number;
  /** the first workspace being opened (`openFirst`), settled once it is done; null while none is */
  private opening: Promise<void> | null = null;
  /** the screen is leaving (`leave`): nothing more is started, and no read still on its way is waited for */
  private leaving = false;
  private readonly left = Promise.withResolvers<null>();

  constructor(private readonly options: LayoutWritesOptions) {
    const { hc } = options;
    this.wall = options.wall ?? Date.now;
    this.store = new LayoutStore(hc, {
      snapshot: async () => (await this.fresh()).view,
      newId: newLayoutId,
      terminal: async (address) => {
        const found = await hc.call("terminal.get", { terminal: address });
        if (found.state !== "live") throw new AdapterError("pane_not_found", `terminal ${address} has finished`);
        return found;
      },
      terminalEnv: async () => ({ ...TERMINAL_COLOUR }),
    });
  }

  /** Whether `effect` is a layout action: one `run` performs. */
  writes(effect: RunEffect): boolean {
    return this.work(effect) !== null;
  }

  /**
   * Opens a first workspace on a core that has none, as herdr's server does when a client connects: a shell in the folder
   * the screen was started from (the core's own folder when it has none), named `~` in the home and after the folder
   * anywhere else, as a new workspace is (`firstShell`). Every screen on the core, and the browser, share it, so the
   * create is guarded by a claim in the layout document taken by compare-and-set (`claimFirst`): of the screens that
   * find the core empty at once, one creates. Answers as a layout write does (the new pane is where input read meanwhile
   * goes), and never rejects: a failure is a notice. null while another write is in flight or the screen is leaving:
   * nothing was asked.
   */
  openFirst(): Promise<FirstDone> | null {
    if (this.busy || this.leaving) return null;
    this.busy = true;
    const done = this.claimFirst().catch(async (error: unknown): Promise<FirstDone> => {
      await this.refused("new_workspace", error);
      return unknownAnswer(error) ? { ended: [], dropInput: "layout_unknown" } : NOTHING_ENDED;
    }).finally(() => {
      this.busy = false;
      this.opening = null;
    });
    this.opening = done.then(() => {});
    return done;
  }

  /**
   * The screen is leaving. A first workspace it is opening is settled first, while the line is open: no read on its way
   * is waited for and nothing more is started, so a claim it took is let go at once; a shell's start already sent is
   * answered first, then its claim let go. Answers when that is done; null when no first workspace is being opened.
   */
  leave(): Promise<void> | null {
    this.leaving = true;
    this.left.resolve(null);
    return this.opening;
  }

  /** `read`'s answer, or null once the screen is leaving: a read that never answers holds no leaving screen. */
  private unlessLeft<T>(read: Promise<T>): Promise<T | null> {
    return Promise.race([read, this.left.promise]);
  }

  /**
   * The first workspace's claim: `{ opening: true, until }` under a key of the layout document beside its workspaces.
   * Every reader keeps only the schema and the workspaces (snapshot.ts `keptLayout`), so no reader sees it. It holds
   * until its time (`FIRST_CLAIM_MS` from when it was written, by the wall clock), and the document's version says whose
   * it is: only the screen whose write made that version takes it again or takes it out. Steps:
   * 1. read the document, then the terminals: nothing to do unless the core has no terminal and Ovis arranges its layout;
   * 2. a claim still within its time is another screen's: this one looks again when that time is up (`again`);
   * 3. write the claim at the version read (over one past its time: its screen died holding it): a screen that loses
   *    the race gets a conflict, and looks again after a claim's time;
   * 4. read the terminals again: another client may have opened one meanwhile;
   * 5. write the claim again, with a new time, right before the shell starts: a screen held up past its claim's time
   *    finds another's write there and starts nothing, so a slow screen and the one that took over never both start one;
   * 6. start the shell, then take the claim out of the document, whatever the start answered.
   * A screen that leaves in between lets its claim go first (`leave`). One that dies leaves it to its time.
   */
  private async claimFirst(): Promise<FirstDone> {
    const { hc } = this.options;
    if (!layoutCalls(await hc.hello())) return NOTHING_ENDED;
    const read = await this.unlessLeft((async () => {
      const doc = await hc.call("doc.get", { name: OVIS_LAYOUT_DOC });
      const [list, app] = await Promise.all([hc.call("terminal.list", {}), hc.call("doc.get", { name: LAYOUT_DOC })]);
      return { doc, list, app };
    })());
    if (read === null) return NOTHING_ENDED;
    const { doc, list, app } = read;
    if (!ownsLayout(app.value) || foreignLayout(doc.value) || list.terminals.length > 0) return NOTHING_ENDED;
    const now = this.wall();
    const held = claimedUntil(doc.value, now);
    if (held !== null) return { ended: [], again: held - now };
    const { [FIRST_CLAIM]: _lapsed, ...rest } = isRecord(doc.value) ? doc.value : { schema: OVIS_LAYOUT_SCHEMA, workspaces: [] };
    const claim: FirstClaim = { rest, version: doc.version };
    if (!await this.take(claim)) return { ended: [], again: FIRST_CLAIM_MS };
    try {
      const listed = await this.unlessLeft(hc.call("terminal.list", {}));
      if (listed === null || listed.terminals.length > 0) return NOTHING_ENDED;
      if (!await this.take(claim)) return { ended: [], again: FIRST_CLAIM_MS };
      if (this.leaving) return NOTHING_ENDED;
      return this.follow(await this.createFirst(), null);
    } finally {
      await this.letGo(claim);
    }
  }

  /**
   * Writes this screen's claim at the version it knows, with a new time. False when another writer came first: the claim
   * is another screen's now, or the document changed and dropped it.
   */
  private async take(claim: FirstClaim): Promise<boolean> {
    if (claim.version === null) return false;
    try {
      const value = { ...claim.rest, [FIRST_CLAIM]: { opening: true, until: this.wall() + FIRST_CLAIM_MS } };
      claim.version = (await this.options.hc.call("doc.set", { name: OVIS_LAYOUT_DOC, value, version: claim.version })).version;
      return true;
    } catch (error) {
      if (!(error instanceof HcError && error.kind === "conflict")) throw error;
      claim.version = null;
      return false;
    }
  }

  /** Takes this screen's claim out of the document, which is then as the browser and every reader know it. */
  private async letGo(claim: FirstClaim): Promise<void> {
    const { version } = claim;
    if (version === null) return;
    claim.version = null;
    try {
      await this.options.hc.call("doc.set", { name: OVIS_LAYOUT_DOC, value: claim.rest, version });
    } catch {
      // another writer changed the document since (the claim is gone with that, or is not this screen's), or the line
      // ended: a claim still there holds no longer than its time
    }
  }

  /**
   * Starts the first workspace's shell (`firstShell`) and answers its terminal. A folder the core refuses (removed, or
   * not usable: hc answers the start `spawn_failed`) gives way to the core's own folder, named `~` as herdr's, once and
   * under the same claim, with a calm notice naming the folder. Only that answer to the start does: any other failure
   * says nothing against the folder, and one after the start (a line that ended, a timeout) may have made the shell, so
   * nothing is started again then.
   */
  private async createFirst(): Promise<string> {
    const shell = this.firstShell();
    try {
      return await this.store.startWorkspace(shell);
    } catch (error) {
      if (shell.cwd === undefined || !(error instanceof HcReplyError && error.kind === "spawn_failed")) throw error;
      this.notice("first_folder_unusable", { folder: shell.cwd }, true);
      return this.store.startWorkspace({ name: HOME_NAME });
    }
  }

  /** The first workspace's shell: the screen's folder, and herdr's name for the home there (a new workspace's otherwise). */
  private firstShell(): { cwd?: string; name?: string } {
    const { folder, home } = this.options;
    if (folder === undefined) return { name: HOME_NAME };
    return folder === home ? { cwd: folder, name: HOME_NAME } : { cwd: folder };
  }

  /**
   * Performs `effect` when it is a layout action and answers when it is done, with the terminals it ended (it never
   * rejects: a failure is a notice); null for any other action.
   */
  run(effect: RunEffect): Promise<LayoutDone> | null {
    const work = this.work(effect);
    if (work === null) return null;
    if (this.busy) {
      this.notice("layout_busy", { action: effect.action });
      return Promise.resolve(NOTHING_ENDED);
    }
    this.busy = true;
    return work().then((done) => done ?? NOTHING_ENDED, async (error: unknown): Promise<LayoutDone> => {
      await this.refused(effect.action, error);
      return unknownAnswer(error) ? { ended: [], dropInput: "layout_unknown" } : effect.action === "zoom_follow" ? { ended: [], refreshZoom: true } : NOTHING_ENDED;
    }).finally(() => {
      this.busy = false;
    });
  }

  private work(effect: RunEffect): (() => Promise<LayoutDone | void>) | null {
    const { action, target } = effect;
    const id = target?.id;
    const store = this.store;
    if (action === "new_workspace") {
      return async () => this.follow((await store.createWorkspace(this.options.folder === undefined ? {} : { cwd: this.options.folder })).root_pane.pane_id, null);
    }
    if (id === undefined) return null;
    if (action === "new_tab") return async () => this.follow((await store.createTab(id, effect.name ? { name: effect.name } : {})).root_pane.pane_id, null);
    if (Object.hasOwn(SPLITS, action)) return async () => this.follow((await store.split(id, SPLITS[action]!)).pane_id, null);
    if (action === "close_pane" || action === "close_tab" || action === "close_workspace" || action === "close_group") {
      const close: CloseTarget = action === "close_pane" ? { pane: id } : action === "close_tab" ? { tab: id } : { workspace: id, group: action === "close_group" };
      return () => this.close(action, close, effect.seen ?? []);
    }
    if (action === "swap_with" && effect.to !== undefined) {
      const to = effect.to;
      return async () => this.unchanged(action, await store.edit(swapEdit(id, to, null)));
    }
    if (action === "passthrough" && effect.setting !== undefined) {
      const on = effect.setting;
      return async () => this.unchanged(action, await store.edit(passthroughEdit(id, on)));
    }
    if (action === "collapse_group" && effect.setting !== undefined) {
      const on = effect.setting;
      return async () => this.unchanged(action, await store.edit(collapseEdit(id, on)));
    }
    if (action === "list_worktrees") return () => this.listWorktrees(id);
    if (action === "prepare_worktree") return () => this.prepareWorktree(id);
    if (action === "prepare_remove") return () => this.prepareRemove(id);
    if (action === "create_worktree" && effect.name) {
      const branch = effect.name;
      return async () => {
        if (!effect.worktree || (await this.options.hc.hello()).core.id !== effect.worktree.core) return;
        const made = await this.options.server.createWorktree(id, branch, effect.worktree);
        if (made.ok) return this.follow(made.value.pane, null);
        this.serverRefused("new_worktree", made);
        if (made.code === "no_server") return { ended: [], dropInput: "layout_unknown" };
      };
    }
    if (action === "remove_worktree") {
      return async () => {
        if (!effect.worktree?.checkout || (await this.options.hc.hello()).core.id !== effect.worktree.core) return;
        const { shown } = (await this.fresh()).view;
        const ended = shown.panes.filter((pane) => pane.workspace_id === id).map((pane) => pane.pane_id);
        const removed = await this.options.server.removeWorktree(id, effect.worktree);
        if (removed.ok) return { ended };
        this.serverRefused("delete_checkout", removed);
        if (removed.code === "no_server") return { ended: [], dropInput: "layout_unknown" };
      };
    }
    if (action === "open_checkout" && effect.path !== undefined) {
      const path = effect.path;
      return () => this.openCheckout(path);
    }
    if (action === "rename_workspace") return () => store.rename({ workspace: id, name: effect.name ?? "" });
    if (action === "rename_tab") return () => store.rename({ tab: id, name: effect.name ?? "" });
    if (action === "rename_pane") return () => store.rename({ pane: id, name: effect.name || null });
    if (action === "zoom") return async () => {
      const result = await store.edit(zoomEdit(id, "toggle"));
      if (result.changed) return { ended: [], refreshZoom: true };
      this.unchanged(action, result);
      return NOTHING_ENDED;
    };
    if (action === "zoom_follow" && effect.zoomTab !== undefined) {
      return async () => {
        await store.edit((layout) => {
          const tab = layout.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === effect.zoomTab);
          // A different writer may have unzoomed this tab or moved the target while the intent waited.
          return tab && tab.zoomed !== null && leaves(tab.root).includes(id)
            ? zoomEdit(id, "on")(layout)
            : { layout: null, reason: "stale" };
        });
        return { ended: [], refreshZoom: true };
      };
    }
    if (Object.hasOwn(SWAPS, action)) return async () => this.unchanged(action, await store.edit((layout) => {
      const result = swapEdit(id, null, SWAPS[action]!)(layout);
      return effect.neighbor !== undefined && result.target !== effect.neighbor
        ? { layout: null, reason: "target_changed" } : result;
    }));
    if (Object.hasOwn(RESIZES, action)) return async () => this.unchanged(action, await store.edit(resizeEdit(id, RESIZES[action]!, RESIZE_STEP)));
    if (action === "move_tab_previous" || action === "move_tab_next") {
      return async () => {
        const { shown } = (await this.fresh()).view;
        const workspace = shown.tabs.find((tab) => tab.tab_id === id)?.workspace_id;
        const to = oneStep(shown.tabs.filter((tab) => tab.workspace_id === workspace).map((tab) => tab.tab_id), id, action === "move_tab_next");
        if (to === null) this.unchanged(action, { changed: false, reason: action === "move_tab_next" ? "last" : "first" });
        else this.unchanged(action, await store.moveTab(id, to));
      };
    }
    if (action === "navigate_move_up" || action === "navigate_move_down") {
      return async () => {
        const { shown } = (await this.fresh()).view;
        const to = oneStep(shown.workspaces.map((workspace) => workspace.workspace_id).filter((one) => one !== OTHER_WORKSPACE_ID), id, action === "navigate_move_down");
        if (to === null) this.unchanged(action, { changed: false, reason: action === "navigate_move_down" ? "last" : "first" });
        else this.unchanged(action, await store.moveWorkspace(id, to));
      };
    }
    if (action === "navigate_move_pane" && effect.to !== undefined) {
      const to = effect.to;
      return async () => this.follow(id, (await store.moveToNewTab(id, to, effect.name ?? "")).tab_id);
    }
    return null;
  }

  /**
   * Open worktree...: the repository the workspace's first pane works in, read from git's files (git-head.ts: no process),
   * and its checkouts, each with the workspace showing it, for the dialog.
   */
  private async listWorktrees(workspace: string): Promise<void> {
    const { shown } = (await this.fresh()).view;
    const repository = this.repositoryOfWorkspace(shown, workspace);
    if (repository === null) {
      this.notice("not_git_worktree", { action: "open_worktree" });
      return;
    }
    const open = this.openWorkspaces(shown, repository);
    const checkouts = repository.checkouts.map((checkout): CheckoutRow => ({
      path: checkout.path,
      label: checkout.branch ? worktreeFolder(checkout.branch) : checkout.path.split("/").at(-1) ?? checkout.path,
      open: open.get(checkout.path) ?? null,
    }));
    this.options.answer({ type: "worktrees", target: { kind: "workspace", id: workspace }, checkouts });
  }

  /** New worktree's dialog: the repository the workspace is on (git's files), and the branch herdr's form starts with. */
  private async prepareWorktree(workspace: string): Promise<void> {
    const { core } = await this.options.hc.hello();
    const { shown } = (await this.fresh()).view;
    const repository = this.repositoryOfWorkspace(shown, workspace);
    if (repository === null) {
      this.notice("not_git_worktree", { action: "new_worktree" });
      return;
    }
    this.options.answer({ type: "new_worktree", target: { kind: "workspace", id: workspace }, repo: repository.repo_name, branch: suggestWorktreeBranch(), worktree: { core: core.id, repository: repository.repo_key } });
  }

  /** Delete worktree checkout...'s question names the folder the facts of the worktree's workspace name. */
  private async prepareRemove(workspace: string): Promise<void> {
    const { core } = await this.options.hc.hello();
    const { shown } = (await this.fresh()).view;
    const facts = shown.workspaces.find((candidate) => candidate.workspace_id === workspace)?.worktree;
    if (!facts?.is_linked_worktree) {
      this.notice("not_linked_worktree", { action: "delete_checkout" });
      return;
    }
    const repo = repositoryFiles(facts.checkout_path);
    const gitId = repo && repo.checkout === facts.checkout_path && repo.repo_key === facts.repo_key ? gitDirIdentity(repo.git_dir) : null;
    if (gitId === null) {
      this.serverRefused("delete_checkout", { code: "worktree_target_changed", message: "The checkout could not be identified" });
      return;
    }
    this.options.answer({ type: "remove_worktree", target: { kind: "workspace", id: workspace }, worktree: { core: core.id, repository: facts.repo_key, checkout: { path: facts.checkout_path, gitId } } });
  }

  /** What the Ovis server said instead: none answered (start it with `ovis start`), or its refusal in its own words. */
  private serverRefused(action: string, answer: { readonly code: string; readonly message: string }): void {
    if (answer.code === "no_server") this.notice("ovis_server_none", { action }, true);
    else if (answer.code === "server_not_loopback") this.notice("ovis_server_address", { action }, true);
    else if (answer.code === "ovis_desktop_not_running" || answer.code === "ovis_desktop_changed") this.notice(answer.code, {}, true);
    else this.notice("ovis_server_refused", { action, code: answer.code, message: answer.message });
  }

  /**
   * Opens a checkout as herdr's Open worktree... does: the workspace showing it comes to the front (the reducer did that),
   * else a new workspace with a shell in it; either way it is grouped under the repository's workspace by the facts the
   * server's adapter writes (worktrees.ts `worktreeLabel`), the repository's workspace given its own facts too.
   */
  private async openCheckout(path: string): Promise<LayoutDone | void> {
    const { shown } = (await this.fresh()).view;
    const repository = repositoryFiles(path);
    if (repository === null) {
      this.notice("not_git_worktree", { action: "open_worktree" });
      return;
    }
    const open = this.openWorkspaces(shown, repository);
    const labelled = async (workspace: string, checkout: string, gitDir: string) => {
      if ((await this.store.worktreeLabelOf(shown, workspace))[WORKTREE_LABEL]) return;
      await this.store.label(shown.panes.filter((pane) => pane.workspace_id === workspace).map((pane) => pane.pane_id), { [WORKTREE_LABEL]: worktreeLabel(factsOf(repository, checkout), gitDir) });
    };
    const head = open.get(repository.repo_root);
    if (head !== undefined) await labelled(head, repository.repo_root, repository.repo_key);
    const own = path === repository.repo_root ? repository.repo_key : repository.git_dir;
    const showing = open.get(path);
    if (showing !== undefined) {
      await labelled(showing, path, own);
      return;
    }
    const branch = repository.checkouts.find((checkout) => checkout.path === path)?.branch ?? null;
    const name = branch ? worktreeFolder(branch) : path.split("/").at(-1) ?? path;
    const made = await this.store.createWorkspace({ name, cwd: path, labels: { [WORKTREE_LABEL]: worktreeLabel(factsOf(repository, path), own) } });
    return this.follow(made.root_pane.pane_id, null);
  }

  /** The repository the workspace's first pane works in, from git's files; null outside one. */
  private repositoryOfWorkspace(shown: LayoutView["shown"], workspace: string): Repository | null {
    const pane = shown.panes.find((candidate) => candidate.workspace_id === workspace);
    const folder = pane ? pane.foreground_cwd ?? pane.cwd : null;
    return folder ? repositoryFiles(folder) : null;
  }

  /** Which workspace shows each checkout of the repository: the one its facts name, else the one whose first pane works in it. */
  private openWorkspaces(shown: LayoutView["shown"], repository: Repository): Map<string, string> {
    const open = new Map<string, string>();
    for (const workspace of shown.workspaces) {
      if (workspace.workspace_id === OTHER_WORKSPACE_ID) continue;
      const facts = workspace.worktree;
      const pane = shown.panes.find((candidate) => candidate.workspace_id === workspace.workspace_id);
      const folder = facts ? (facts.repo_key === repository.repo_key ? facts.checkout_path : null) : pane ? pane.foreground_cwd ?? pane.cwd : null;
      if (!folder) continue;
      const checkout = checkoutHolding(repository.checkouts, folder);
      // as the server's adapter: a folder below a checkout is that checkout's only when its own nearest `.git` is the
      // checkout's (a clone or a submodule inside it is a repository of its own); facts naming the checkout count as they are
      if (checkout === null || open.has(checkout) || (!facts && checkoutTop(folder) !== checkout)) continue;
      open.set(checkout, workspace.workspace_id);
    }
    return open;
  }

  /** The core as the screen shows it, read now (the same terminals its world shows: no finished one), with each terminal's created_ms. */
  private async fresh(): Promise<Fresh> {
    const { terminals, ...view } = await readCore(this.options.hc, { ...this.options.model, all: true });
    return {
      view,
      created: new Map(terminals.map((terminal) => [terminal.address, terminal.created_ms])),
    };
  }

  /** A close, once the core still holds exactly the terminals the user saw: it ends those and no other; anything else ends nothing. */
  private async close(action: string, target: CloseTarget, seen: readonly Seen[]): Promise<LayoutDone> {
    let fresh: Fresh;
    try {
      fresh = await this.fresh();
    } catch (error) {
      // Even a lost answer here is only a lost read: the close has not sent a kill or removal.
      this.notice("layout_refused", { action, reason: errorCode(error) });
      return NOTHING_ENDED;
    }
    const { view, created } = fresh;
    const ends = this.store.endsOf(view.shown, target);
    if (!sameTerminals(ends, seen, created)) {
      this.notice("target_changed", { action });
      return NOTHING_ENDED;
    }
    // the screen shows no finished terminal (`fresh`): each of these is killed, then its record removed
    const results = await this.store.endEach(ends, new Set());
    const ended: string[] = [];
    let dropInput: LayoutDone["dropInput"];
    const failure = results.find((one) => one.step !== "removed");
    for (const one of results) {
      if (one.step === "removed" || (one.error instanceof HcReplyError && one.error.kind === "not_found")) ended.push(one.terminal);
      else if (!(one.error instanceof HcReplyError) || unknownAnswer(one.error)) dropInput = "layout_unknown";
      // The kill succeeded, but the terminal's record remains. Don't type into it.
      else if (one.step === "rm") dropInput ??= "not_closed";
    }
    if (dropInput === "layout_unknown") this.notice("layout_unknown", { action });
    else if (failure) await this.refused(action, failure.error);
    return dropInput ? { ended, dropInput } : { ended };
  }

  private follow(pane: string, away: string | null): LayoutDone {
    this.options.answer({ type: "follow", target: { kind: "pane", id: pane }, away });
    return { ended: [], inputTarget: pane };
  }

  private notice(code: string, data: Readonly<Record<string, string>>, calm = false): void {
    this.options.answer({ type: "notice", code, data, ...(calm || data.action === "zoom_follow" ? { calm: true } : {}) });
  }

  /** An edit that changed nothing says why, calmly: the precondition was gone on the document as it is now. */
  private unchanged(action: string, answer: { changed: boolean; reason: string | null }): void {
    if (!answer.changed) this.notice("layout_unchanged", { action, reason: answer.reason ?? "unchanged" }, true);
  }

  /** One notice per failed action, by its stable code. */
  private async refused(action: string, error: unknown): Promise<void> {
    if (error instanceof AdapterError) {
      if (error.code === "unsupported") this.notice(...await this.unsupported(action));
      else if (error.code === "layout_not_saved") this.notice("layout_not_saved", { action });
      else this.notice("layout_refused", { action, reason: error.code });
      return;
    }
    if (error instanceof HcError && error.kind === "conflict") this.notice("layout_conflict", { action }, true);
    // the line ended or the answer never came: what happened is unknown, and nothing is sent again
    else if (unknownAnswer(error)) this.notice("layout_unknown", { action });
    else this.notice("layout_refused", { action, reason: errorCode(error) });
  }

  /** Why the store refused: the Herdr app arranges the core, a newer Ovis wrote the layout, or the core keeps no documents. */
  private async unsupported(action: string): Promise<[string, Record<string, string>]> {
    const { hc } = this.options;
    try {
      const [app, ovis, hello] = await Promise.all([hc.call("doc.get", { name: LAYOUT_DOC }), hc.call("doc.get", { name: OVIS_LAYOUT_DOC }), hc.hello()]);
      if (!ownsLayout(app.value)) return ["app_owned", { action }];
      if (!layoutCalls(hello)) return ["layout_refused", { action, reason: "no_documents" }];
      if (foreignLayout(ovis.value)) return ["layout_refused", { action, reason: "foreign_layout" }];
    } catch {
      // the reads failed too: the store's own answer stands
    }
    return ["layout_refused", { action, reason: "unsupported" }];
  }
}
