import { createContext, useContext, useMemo } from "react";
import * as api from "./api.ts";
import type { HerdrIdentity } from "../../shared/machines.ts";
import type { CreateWorktreeRequest, OpenWorktreeRequest, PaneDirection, PluginActionRequest, RemoveWorktreeRequest, SessionHistoryAgent, SessionResumeRequest, SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";
import { ReorderCoordinator } from "./workspaceOrder.ts";
export const MachineContext = createContext("local");
export const useMachineId = () => useContext(MachineContext);
/**
 * Which layout calls a PC's herdr answers, so the components offer only those, as VS Code's `when`
 * clauses leave a command out of its menus where it cannot run: renaming workspaces and tabs,
 * splitting a pane, moving a one-pane tab to another workspace, `arrange` for the rest (reordering,
 * swap, zoom, resize, pane names) and the worktree actions. herdr's TUI server answers all of them;
 * herdr-core (shared/machines.ts HerdrIdentity.runtime) only as its `layout` says. App provides it per PC beside MachineContext (the selected PC, each half of
 * the split view, each PC's sidebar); everything outside App, as for herdr's own TUI server.
 */
export interface LayoutOffer { rename: boolean; split: boolean; move: boolean; arrange: boolean; worktrees: boolean }
export const FULL_LAYOUT: LayoutOffer = Object.freeze({ rename: true, split: true, move: true, arrange: true, worktrees: true });
const NO_LAYOUT: LayoutOffer = Object.freeze({ rename: false, split: false, move: false, arrange: false, worktrees: false });
const coreOffers = new Map<string, LayoutOffer>();
export const AppLayoutContext = createContext<LayoutOffer>(FULL_LAYOUT);
export const useAppLayout = () => useContext(AppLayoutContext);
export const appLayoutOf = (herdr: HerdrIdentity | undefined): LayoutOffer => {
  if (herdr === undefined) return NO_LAYOUT;
  if (herdr.runtime !== "herdr-core") return FULL_LAYOUT;
  const { rename = false, split = false, move = false, arrange = false, worktrees = false } = herdr.layout ?? {};
  const key = `${rename}:${split}:${move}:${arrange}:${worktrees}`;
  let offer = coreOffers.get(key);
  if (!offer) coreOffers.set(key, offer = Object.freeze({ rename, split, move, arrange, worktrees }));
  return offer;
};
export const ReorderContext = createContext(new ReorderCoordinator());
export const useReorderCoordinator = () => useContext(ReorderContext);
export function useMachineApi() {
  const id = useMachineId();
  return useMemo(() => ({
    fetchPaneTranscript: (pane: string, lines: number, signal?: AbortSignal) => api.fetchPaneTranscript(pane, lines, id, signal),
    fetchPaneConversation: (pane: string, page?: api.ConversationPageQuery) => api.fetchPaneConversation(pane, id, page),
    peekPaneConversation: (pane: string, prompts?: number) => api.peekPaneConversation(pane, id, prompts),
    searchPaneConversation: (pane: string, query: string, page?: Parameters<typeof api.searchPaneConversation>[3]) => api.searchPaneConversation(pane, query, id, page),
    fetchPanePrompt: (pane: string) => api.fetchPanePrompt(pane, id),
    fetchPanePromptState: (pane: string) => api.fetchPanePromptState(pane, id),
    answerPanePrompt: (answer: Parameters<typeof api.answerPanePrompt>[0]) => api.answerPanePrompt(answer, id),
    uploadPaneImage: (pane: string, image: Blob) => api.uploadPaneImage(pane, image, id),
    fetchPaneCommands: (pane: string) => api.fetchPaneCommands(pane, id),
    fetchAgentCommands: (agent: string, cwd: string | null) => api.fetchAgentCommands(agent, cwd, id),
    fetchPaneFiles: (pane: string, query: string, limit = 20) => api.fetchPaneFiles(pane, query, limit, id),
    fetchPaneDocuments: (pane: string, signal?: AbortSignal) => api.fetchPaneDocuments(pane, id, signal),
    findPane: (request: Parameters<typeof api.findPane>[0]) => api.findPane(request, id),
    fetchPaneScroll: (pane: string) => api.fetchPaneScroll(pane, id),
    scrollPane: (pane: string, offset: number) => api.scrollPane(pane, offset, id),
    fetchPaneOmoActivity: (pane: string) => api.fetchPaneOmoActivity(pane, id),
    fetchPaneBackgroundAgent: (pane: string, agent: string) => api.fetchPaneBackgroundAgent(pane, agent, id),
    fetchPanePlan: (pane: string) => api.fetchPanePlan(pane, id),
    fetchPaneArtifacts: (pane: string) => api.fetchPaneArtifacts(pane, id),
    fetchPaneBtw: (pane: string, signal?: AbortSignal) => api.fetchPaneBtw(pane, id, signal),
    closePane: (pane: string) => api.closePane(pane, id),
    focusPane: (pane: string) => api.focusPane(pane, id),
    closeWorkspace: (workspace: string, closeGroup = false) => api.closeWorkspace(workspace, id, closeGroup),
    createWorktree: (request: CreateWorktreeRequest) => api.createWorktree(request, id),
    listWorktrees: (workspace: string) => api.listWorktrees(workspace, id),
    readWorktreeInventory: (workspaces: readonly string[]) => api.readWorktreeInventory(workspaces, id),
    openWorktree: (request: OpenWorktreeRequest) => api.openWorktree(request, id),
    removeWorktree: (request: RemoveWorktreeRequest) => api.removeWorktree(request, id),
    renamePane: (pane: string, label: string) => api.renamePane(pane, label, id),
    renameAgent: (pane: string, name: string | null) => api.renameAgent(pane, name, id),
    splitPane: (pane: string, direction: SplitPaneDirection, focus = false) => api.splitPane(pane, direction, focus, id),
    zoomPane: (pane: string, mode: ZoomMode) => api.zoomPane(pane, mode, id),
    swapPane: (pane: string, direction: PaneDirection) => api.swapPane(pane, direction, id),
    swapPaneWith: (pane: string, target: string) => api.swapPaneWith(pane, target, id),
    setSplitRatio: (tab: string, path: boolean[], ratio: number) => api.setSplitRatio(tab, path, ratio, id),
    resizePane: (pane: string, direction: PaneDirection) => api.resizePane(pane, direction, id),
    clearPane: (pane: string) => api.clearPane(pane, id),
    renameWorkspace: (workspace: string, label: string) => api.renameWorkspace(workspace, label, id),
    moveWorkspace: (workspace: string, index: number) => api.moveWorkspace(workspace, index, id),
    fetchAgentKinds: () => api.fetchAgentKinds(id),
    fetchIntegrations: () => api.fetchIntegrations(id),
    fetchDirectories: (path: string, hidden: boolean, files = false, pane: string | null = null) => api.fetchDirectories(path, hidden, id, files, pane),
    createDirectory: (path: string, name: string) => api.createDirectory(path, name, id),
    fetchFileInfo: (path: string, pane: string | null) => api.fetchFileInfo(path, pane, id),
    fileUrl: (path: string, pane: string | null, download = false) => api.fileUrl(path, pane, id, download),
    fetchEditableText: (path: string, pane: string) => api.fetchEditableText(path, pane, id),
    saveEditableText: (request: Parameters<typeof api.saveEditableText>[0]) => api.saveEditableText(request, id),
    fetchRepoDiffFiles: (query: api.RepoDiffQuery) => api.fetchRepoDiffFiles(query, id),
    fetchRepoDiffFile: (query: api.RepoDiffQuery, path: string, oldPath: string | null) => api.fetchRepoDiffFile(query, path, oldPath, id),
    fetchRepoDiffRefs: (query: Pick<api.RepoDiffQuery, "paneId" | "directory">) => api.fetchRepoDiffRefs(query, id),
    fetchPullRequest: (target: api.PullRequestTarget) => api.fetchPullRequest(target, id),
    fetchPullRequestLog: (target: api.PullRequestTarget, jobId: string, host: string) => api.fetchPullRequestLog(target, jobId, host, id),
    mergePullRequest: (target: api.PullRequestTarget, merge: Parameters<typeof api.mergePullRequest>[1]) => api.mergePullRequest(target, merge, id),
    createWorkspace: (request: api.CreateWorkspaceRequest) => api.createWorkspace(request, id),
    createTab: (request: api.CreateTabRequest) => api.createTab(request, id),
    fetchSessionHistory: (workspace: string, agent: SessionHistoryAgent, pane: string | null = null) => api.fetchSessionHistory(workspace, agent, id, pane),
    resumeSession: (request: SessionResumeRequest) => api.resumeSession(request, id),
    sessionHistoryOffered: () => api.sessionHistoryOffered(id),
    renameTab: (tab: string, label: string) => api.renameTab(tab, label, id),
    closeTab: (tab: string) => api.closeTab(tab, id),
    moveTab: (tab: string, index: number) => api.moveTab(tab, index, id),
    moveTabToWorkspace: (tab: string, workspace: string) => api.moveTabToWorkspace(tab, workspace, id),
    fetchPluginActions: () => api.fetchPluginActions(id),
    runPluginAction: (request: PluginActionRequest) => api.runPluginAction(request, id),
    fetchPluginActionStatus: (pluginId: string, logId: string) => api.fetchPluginActionStatus(pluginId, logId, id),
  }), [id]);
}
