/**
 * The status of a Letta Code pane that no report gives one (herdr-core: Letta sends no OSC 7501),
 * read from Letta's own local record of the conversation the pane shows.
 *
 * Letta's transcript is written only when a turn ends, so it cannot say a turn runs. Its local
 * backend appends each message to the conversation's `messages.jsonl` as the turn goes, in the
 * shape gjc's transcript has (letta-code 0.34.44): a user prompt, a tool result or an assistant
 * message that stopped for a tool means work; one that stopped for good is rest, one that errored
 * or was aborted a rest after a failure. A cloud conversation keeps its messages on the server:
 * its status stays unknown.
 */
import type { AgentStatus } from "../shared/herdr-api.generated.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { LETTA_ASKING_TITLE, LETTA_BUSY_TITLE, titleStatus } from "./agent-identity.ts";
import { gjcTurnAfter } from "./gjc-status.ts";
import { lettaMessagesPath, resolveLettaTranscript } from "./letta-store.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readOmoLinesCooperatively, type OmoLine } from "./omo-records.ts";
import { OmoStatus, type OmoFile, type OmoPane, type OmoStatusDeps, type OmoTurn } from "./omo-status.ts";

/**
 * Letta's local messages share gjc's record shape, so gjc's reducer reads their turns; but no Letta
 * tool is a prompt waiting on the user, whatever its name (gjc's `ask` is). That Letta waits shows
 * only in its title (titleStatus), so no question is ever opened from the file.
 */
export function lettaTurnAfter(turn: OmoTurn, line: OmoLine): OmoTurn {
  return { ...gjcTurnAfter(turn, line), asks: [] };
}

export const LETTA_MESSAGES_BYTES = 4 * 1024 * 1024;

/** Opened never through a link, never waiting on a FIFO. */
const MESSAGES_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Whether `path` (`<store>/conversations/<key>/messages.jsonl`) is a regular file at exactly that place
 * under its store's real path: no link for the file, its folder or any folder up to the store, so it is
 * never another conversation's or another store's.
 */
function ownMessagesFile(path: string): { dev: bigint; ino: bigint } | null {
  try {
    // as bigints: a large inode number rounded to a double could match another file's
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) return null;
    const folder = dirname(path);
    const store = dirname(dirname(folder));
    return realpathSync(path) === join(realpathSync(store), "conversations", basename(folder), basename(path)) ? { dev: stat.dev, ino: stat.ino } : null;
  } catch { return null; }
}

/** The reader of Letta's messages files for the tracker: its own regular file only, read from its last `cap` bytes when read anew. */
export function lettaMessagesFile(cap = LETTA_MESSAGES_BYTES): OmoFile {
  const open = (path: string): number | null => {
    const checked = ownMessagesFile(path);
    if (checked === null) return null;
    let fd: number;
    try { fd = openSync(path, MESSAGES_FLAGS); } catch { return null; }
    // a folder above it swapped for a link between the check and the open opens another file: the same one must be open
    try { const opened = fstatSync(fd, { bigint: true }); if (opened.isFile() && opened.dev === checked.dev && opened.ino === checked.ino) return fd; } catch {}
    closeSync(fd);
    return null;
  };
  return {
    stat: (path) => {
      const fd = open(path);
      if (fd === null) return null;
      try { const stat = fstatSync(fd, { bigint: true }); return { size: Number(stat.size), id: `${stat.dev}:${stat.ino}` }; } finally { closeSync(fd); }
    },
    lines: (path, from, size, each, current) => {
      const fd = open(path);
      if (fd === null) return from;
      const start = from === 0 && size > cap ? size - cap : from;
      try {
        const read = readOmoLinesCooperatively(fd, start, size, each, current);
        if (read instanceof Promise) return read.catch(() => from).finally(() => closeSync(fd));
        closeSync(fd);
        return read;
      } catch { closeSync(fd); return from; }
    },
  };
}

type Bound = { store: string; agent: string; conversation: string; startedAt: number };

export interface LettaDiscovery {
  resolve?: (pane: HerdrPane, panes: readonly HerdrPane[]) => Promise<Bound | null>;
}

export async function lettaPanes(panes: HerdrPane[], deps: LettaDiscovery = {}): Promise<Map<string, OmoPane>> {
  const resolve = deps.resolve ?? ((pane: HerdrPane, all: readonly HerdrPane[]) => resolveLettaTranscript(pane, all).catch(() => null));
  const found = new Map<string, OmoPane>();
  await Promise.all(panes.filter((pane) => pane.agent === "letta" && pane.agent_status === "unknown").map(async (pane) => {
    const bound = await resolve(pane, panes);
    found.set(pane.pane_id, bound === null ? { path: null, startedAt: null } : { path: lettaMessagesPath(bound.store, bound.agent, bound.conversation), startedAt: bound.startedAt });
  }));
  return found;
}

/**
 * A Letta pane still without a status once its local messages had their say (a cloud conversation,
 * whose messages are on the server, or one not bound): Letta's own title, which carries a spinner
 * while a turn runs.
 */
export function lettaTitleStatus(snapshot: { panes: HerdrPane[]; agents?: { pane_id: string; agent_status: AgentStatus }[] }, tracks: (paneId: string) => boolean, last: Map<string, AgentStatus>, newest = true): { paneId: string; status: AgentStatus }[] {
  const { panes } = snapshot;
  if (!newest) {
    for (const pane of panes) {
      if (pane.agent !== "letta") continue;
      if (!tracks(pane.pane_id) && pane.agent_status === "unknown") pane.agent_status = last.get(pane.pane_id) ?? pane.agent_status;
      else if (tracks(pane.pane_id) && last.get(pane.pane_id) === "blocked") pane.agent_status = "blocked";
    }
    syncAgents(snapshot);
    return [];
  }
  const changed: { paneId: string; status: AgentStatus }[] = [];
  const titled = new Set<string>();
  for (const pane of panes) {
    if (pane.agent !== "letta") continue;
    if (tracks(pane.pane_id)) {
      // the messages file speaks, but shows a call waiting for the user's approval only as a call: the title says it waits
      if (pane.agent_status === "working" || pane.agent_status === "idle" || pane.agent_status === "done") {
        const said = titleStatus(pane.agent, pane.terminal_title);
        const asking = said === "blocked";
        // approved, the call runs and the title spins: the file may still end at an answer from before the wait
        const status: AgentStatus = asking ? "blocked" : last.get(pane.pane_id) === "blocked" && said === "working" ? "working" : pane.agent_status === "working" ? "working" : "idle";
        const before = last.get(pane.pane_id);
        if (before === undefined ? status === "blocked" : before !== status && (status === "blocked" || before === "blocked")) changed.push({ paneId: pane.pane_id, status });
        if (asking || status === "working") pane.agent_status = status;
        last.set(pane.pane_id, status);
        titled.add(pane.pane_id);
      }
      continue;
    }
    if (pane.agent_status !== "unknown") continue;
    // the program's own title only: elsewhere `title` may be a pane's label
    const status = titleStatus(pane.agent, pane.terminal_title);
    if (status === null) continue;
    pane.agent_status = status;
    titled.add(pane.pane_id);
    const before = last.get(pane.pane_id);
    if (before === undefined ? status === "working" : before !== status) changed.push({ paneId: pane.pane_id, status });
    last.set(pane.pane_id, status);
  }
  for (const paneId of [...last.keys()]) if (!titled.has(paneId)) last.delete(paneId);
  syncAgents(snapshot);
  return changed;
}

function syncAgents(snapshot: { panes: HerdrPane[]; agents?: { pane_id: string; agent_status: AgentStatus }[] }): void {
  const status = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane.agent_status]));
  for (const agent of snapshot.agents ?? []) agent.agent_status = status.get(agent.pane_id) ?? agent.agent_status;
}

export function lettaRefreshKey(pane: HerdrPane): string {
  if (pane.agent !== "letta") return "";
  const title = pane.terminal_title ?? "";
  const mark = LETTA_ASKING_TITLE.test(title) ? "asking" : LETTA_BUSY_TITLE.test(title) ? "busy" : "";
  return `${mark}\0${title.replace(LETTA_ASKING_TITLE, "").replace(LETTA_BUSY_TITLE, "")}`;
}

export function createLettaStatus(deps: Omit<OmoStatusDeps, "agent" | "aliases" | "turnAfter" | "ready" | "background" | "staleIsFailure" | "refreshMs" | "refreshKey" | "file">): OmoStatus {
  return new OmoStatus({
    ...deps,
    refreshKey: lettaRefreshKey,
    file: lettaMessagesFile(),
    agent: "letta",
    aliases: [],
    turnAfter: lettaTurnAfter,
    ready: ({ turn, available, complete }) => turn.status !== null && available && complete,
    background: () => new Map(),
    staleIsFailure: true,
  });
}
