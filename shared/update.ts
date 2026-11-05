/** App updates are independent of the herdr daemon and its terminal sessions. */
export interface UpdateStatus {
  managed: boolean;
  auto_update: boolean;
  phase: "idle" | "checking" | "building" | "restarting" | "error";
  /** Commit ids: what is running and what the latest release tag points at. */
  current_revision: string | null;
  latest_revision: string | null;
  /** Human versions: the running build's package.json and the latest `vX.Y.Z` tag, without the v. */
  current_version: string | null;
  latest_version: string | null;
  available: boolean;
  checked_at: string | null;
  blocked_reason: string | null;
  error: string | null;
  /**
   * What a running install is doing; null outside one. Absent from a supervisor older than this
   * field: an update is always run by the version being replaced.
   */
  step?: UpdateStep | null;
  /**
   * The commit the client build the server serves now was made from, once it differs from
   * `current_revision`; null otherwise. The server serves its directory's `dist/` on every request,
   * so a source checkout rebuilt under it (a plugin reinstall, or `git pull` and a build) is served
   * before the server runs it: a tab of that build cannot be reloaded onto the running revision,
   * only a restart reports it. Read by the bridge when a tab asks. Absent from an older server.
   */
  served_revision?: string | null;
  /**
   * A stable name for `error` where the client words it itself: `update_offer_changed` when a
   * manual install found a different release on offer than the one it was asked for, and so
   * installed nothing. Absent or null otherwise, and from a supervisor older than the field.
   */
  error_code?: UpdateErrorCode | null;
  /**
   * The supervisor installs only the exact revision a manual install names. Absent from an older
   * supervisor, which would install whatever its own check finds: the controls then ask for a
   * restart instead of offering an install.
   */
  revision_bound_install?: boolean;
  /**
   * Where this server answers, told only to the connection server that reaches it as its PC (its
   * bridge token), which cannot read GET /api/access (#2191): the port it listens on, and the HTTPS
   * address Tailscale already serves it at (RemoteAccess.port, TailscaleAccess.serving_url). Absent
   * from any other caller's answer and from an older server.
   */
  port?: number;
  serving_url?: string | null;
  /**
   * Which builds this PC updates to: `stable` releases only, or also the `beta` builds CI publishes
   * from green main. Absent from a supervisor older than the field, which offers releases only.
   */
  channel?: UpdateChannel;
}

/**
 * `stable` takes `vX.Y.Z` releases only; `beta` also takes the `vX.Y.Z-beta.N` builds CI tags on
 * main once its checks pass. Off (`stable`) unless the PC opts in.
 */
export type UpdateChannel = "stable" | "beta";

/**
 * The channel a setting names (`OVIS_UPDATE_CHANNEL`, or the `update-channel` file in the state
 * dir): `beta` turns the beta builds on, `stable` off; anything else names none.
 */
export function readUpdateChannel(value: string | null | undefined): UpdateChannel | null {
  const name = value?.trim().toLowerCase();
  return name === "beta" || name === "stable" ? name : null;
}

export type UpdateErrorCode = "update_offer_changed";
/** A full commit id, as `latest_revision` names it. */
export const REVISION = /^[0-9a-f]{40,64}$/;

/**
 * What the bridge asks of the update service: a check, or the install of the exact revision the
 * person saw offered. A manual install never goes without its revision.
 */
export type UpdateRequest = { command: "check" } | { command: "install"; expected_revision: string };

/**
 * The supervisor's reading of a bridge's IPC message. `update-command` carries only a check: an
 * unbound install there is the older bridge's, and it is refused. The install travels as
 * `update-install-revision`, a type an older supervisor does not know and so ignores, never
 * running it as an install of whatever its own check finds.
 */
export function readUpdateIpcRequest(message: unknown): UpdateRequest | null {
  const value = message as { type?: unknown; command?: unknown; expected_revision?: unknown } | null | undefined;
  if (typeof value !== "object" || value === null) return null;
  if (value.type === "update-command" && value.command === "check") return { command: "check" };
  if (value.type === "update-install-revision" && typeof value.expected_revision === "string" && REVISION.test(value.expected_revision)) {
    return { command: "install", expected_revision: value.expected_revision };
  }
  return null;
}

/** The update check's reason for a source checkout that moved since the server started. */
export const CHECKOUT_CHANGED_REASON = "The source checkout changed. Restart the app before updating.";

/** An install's steps, in the order it takes them. */
export const UPDATE_STEPS = ["download", "dependencies", "typecheck", "build", "restart"] as const;
export type UpdateStep = typeof UPDATE_STEPS[number];

export type UpdateCommand = "check" | "install";

/** The languages a release's summary is written in: the app's own (src/lib/i18n.ts). */
export const SUMMARY_LANGUAGES = ["en", "ko", "ja", "zh"] as const;
export type SummaryLanguage = typeof SUMMARY_LANGUAGES[number];
/** The lists a summary is told in, in the order they are read. */
export const SUMMARY_GROUPS = ["new", "improved", "fixed"] as const;
export type SummaryGroup = typeof SUMMARY_GROUPS[number];
/** A release as patch notes: short lines of plain text under what is new, improved and fixed. A list with no line is absent. */
export type ReleaseHighlights = Partial<Record<SummaryGroup, string[]>>;
/** A release's highlights per language; a language the release did not write is absent. */
export type ReleaseSummary = Partial<Record<SummaryLanguage, ReleaseHighlights>>;
/** A highlight is one line, and a list a handful of them: what is longer is cut where it is read. */
export const HIGHLIGHT_LIMIT = 160;
export const HIGHLIGHTS_PER_GROUP = 8;
/** An answer names this many releases at most: a jump over more is counted, not listed, wherever an answer is read. */
export const RELEASES_LIMIT = 50;

/** One release's section of CHANGELOG.md, and its summary from release-summaries.json. */
export interface ReleaseNote {
  /** without the v */
  version: string;
  /** the date in the section's heading, as written there; null when it has none */
  date: string | null;
  /** the section's body, Markdown */
  notes: string;
  /** absent from a release older than the summaries, and from one that wrote none */
  summary?: ReleaseSummary;
}

/**
 * GET /api/updates/notes: what the available update brings. Asked for once per release, and
 * kept out of the status, which is polled.
 */
export interface UpdateNotes {
  /** the commit of the release these notes were read from, the status's `latest_revision` then; null when no update is offered */
  revision: string | null;
  /** every release after the running one, up to the latest, newest first; empty when no update is offered or its changelog has no section for it */
  releases: ReleaseNote[];
  /** older releases the update also brings, left out for length */
  omitted: number;
}

export function noUpdateNotes(): UpdateNotes {
  return { revision: null, releases: [], omitted: 0 };
}

/**
 * GET /api/updates/installed: what the last update brought, read from the running release's own
 * files. Asked for once per running release, like the notes of an offer.
 */
export interface InstalledNotes {
  /** the commit this answer is for, the status's `current_revision`; null when no supervisor has told (an unmanaged server, a supervisor older than the question) */
  revision: string | null;
  /** the running version and the one the update replaced, without the v; both null when no update installed what runs (a source checkout) */
  version: string | null;
  previous_version: string | null;
  /** when the update was installed, ISO */
  installed_at: string | null;
  /** every release after the replaced one, up to the running one, newest first; empty when the release has no changelog section for them */
  releases: ReleaseNote[];
  /** older releases the update also brought, left out for length */
  omitted: number;
}

export function noInstalledNotes(): InstalledNotes {
  return { revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 };
}

/**
 * A summary as it was written or sent (release-summaries.json from a Git remote, the supervisor
 * over IPC, the server over HTTP): the lines that are text, under the lists and languages the
 * app has, each cut to a line and each list to a handful. Nothing when no line is left.
 */
export function readSummary(value: unknown): ReleaseSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const summary: ReleaseSummary = {};
  for (const language of SUMMARY_LANGUAGES) {
    const written: unknown = (value as Record<string, unknown>)[language];
    if (typeof written !== "object" || written === null) continue;
    const highlights: ReleaseHighlights = {};
    for (const group of SUMMARY_GROUPS) {
      const lines: unknown = (written as Record<string, unknown>)[group];
      if (!Array.isArray(lines)) continue;
      const kept = lines.filter((line): line is string => typeof line === "string" && line.trim() !== "")
        .slice(0, HIGHLIGHTS_PER_GROUP)
        .map((line) => line.trim())
        .map((line) => line.length > HIGHLIGHT_LIMIT ? `${line.slice(0, HIGHLIGHT_LIMIT).trimEnd()}…` : line);
      if (kept.length > 0) highlights[group] = kept;
    }
    if (Object.keys(highlights).length > 0) summary[language] = highlights;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** The releases of an answer, or null when one of them is not in shape; `dropped` counts those past the cap. */
function readReleases(value: unknown): { releases: ReleaseNote[]; dropped: number } | null {
  if (!Array.isArray(value)) return null;
  const releases: ReleaseNote[] = [];
  // what is past the cap is not read, and counted as omitted: an answer is bounded here, whatever sent it
  const dropped = Math.max(0, value.length - RELEASES_LIMIT);
  for (const entry of (value as Array<Partial<Record<keyof ReleaseNote, unknown>> | null>).slice(0, RELEASES_LIMIT)) {
    if (typeof entry?.version !== "string" || typeof entry.notes !== "string") return null;
    if (entry.date !== null && typeof entry.date !== "string") return null;
    const summary = readSummary(entry.summary);
    releases.push({ version: entry.version, date: entry.date, notes: entry.notes, ...(summary ? { summary } : {}) });
  }
  return { releases, dropped };
}

const readOmitted = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

/**
 * Notes as another process or another version sent them (the supervisor over IPC, the server
 * over HTTP). Anything that is not in shape is no notes: they are drawn as they are.
 */
export function readUpdateNotes(value: unknown): UpdateNotes {
  const notes = value as Partial<Record<keyof UpdateNotes, unknown>> | null | undefined;
  const read = typeof notes === "object" && notes !== null ? readReleases(notes.releases) : null;
  if (!notes || !read) return noUpdateNotes();
  return { revision: typeof notes.revision === "string" ? notes.revision : null, releases: read.releases, omitted: readOmitted(notes.omitted) + read.dropped };
}

/**
 * The last update's notes, read as `readUpdateNotes` reads an offer's. An update is told only
 * with both of its versions: an answer without them says, for its commit, that there is none.
 */
export function readInstalledNotes(value: unknown): InstalledNotes {
  const notes = value as Partial<Record<keyof InstalledNotes, unknown>> | null | undefined;
  const read = typeof notes === "object" && notes !== null ? readReleases(notes.releases) : null;
  if (!notes || !read || typeof notes.revision !== "string") return noInstalledNotes();
  if (typeof notes.version !== "string" || typeof notes.previous_version !== "string") return { ...noInstalledNotes(), revision: notes.revision };
  return {
    revision: notes.revision, version: notes.version, previous_version: notes.previous_version,
    installed_at: typeof notes.installed_at === "string" ? notes.installed_at : null,
    releases: read.releases, omitted: readOmitted(notes.omitted) + read.dropped,
  };
}

export function unmanagedUpdateStatus(): UpdateStatus {
  return {
    managed: false, auto_update: false, phase: "idle", current_revision: null,
    latest_revision: null, current_version: null, latest_version: null, available: false, checked_at: null, error: null,
    blocked_reason: "Start with bun run start or the herdr plugin to enable updates.",
  };
}

/**
 * herdr itself, updated from the app (server/herdr-update.ts): the server runs
 * `herdr update --handoff` for the herdr it talks to, on its own PC.
 */
export interface HerdrUpdateStatus {
  /** false where the server offers no herdr update (Windows, a herdr that does not answer): the controls stay hidden */
  supported: boolean;
  phase: "idle" | "updating" | "error";
  /** the running herdr server, and the herdr binary installed beside it */
  server_version: string | null;
  binary_version: string | null;
  /** the installed binary is newer than the running server: an update moves the panes onto it */
  stale: boolean;
  /** what herdr printed on the last run, its tail; null before any run and while one runs */
  output: string | null;
  finished_at: string | null;
}
