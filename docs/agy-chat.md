# Antigravity Chat

Chat reads the active Agy conversation's `transcript_full.jsonl`. User messages,
assistant text and expandable tool activity use the existing Chat view. Terminal
remains available for native commands and approvals. Reading Chat makes no model call.

The reader follows the presence lock held by the pane's Agy process, including after
`/new` and `/resume`. It does not choose a session by directory, timestamp or startup
arguments, and needs no hook or status-line configuration.

The ledger is replayed in order: repeated or backwards step indices replace the
corresponding suffix. A read-only query of the conversation database's step indices
also honors a saved rewind before replacement ledger records arrive. The reader does
not decode database payloads. Changed history invalidates older-page cursors and
expanded output references; ordinary appends preserve them.

Planner calls and exported tool results have no shared native call ID in the tested
format, so results appear as independent tool-output rows. Hidden context and reasoning
are omitted. Image rendering and child-session expansion are outside this first scope.
The known `<USER_REQUEST>` wrapper is removed only when followed by the native
metadata suffix; standalone literal wrapper text is preserved. Error-only records
without text are not rendered. Only completed (`DONE`) exported steps are rendered; an unfinished last row waits,
and an unfinished historical row does not hide later completed turns.

Chat shows Working from the current native turn, even while Herdr reports ready or done.
A completed user step starts activity. A planner response with tools continues it; a
completed tool-free planner answer clears it. Tool results and hidden context do not
restart a finished turn. This follows the captured Agy 1.3.3 prompt/tool/final-answer
sequence; `DONE` on a tool step alone does not finish the turn. The database still supplies
only active indices, not guessed numeric status meanings. AGY does not export live thought
chunks, so Chat shows Working rather than inferring Thinking from saved reasoning.

This is display feedback, not input readiness. Interrupted or errored turns without a
final planner answer can remain active, including a saved rewind retaining an unfinished
turn. A new native turn or rewind recomputes the indicator from the retained history.
Unsupported completion patterns may have the same limitation. Unavailable native history
gets an explicit notice; session identity and terminal fallback rules are unchanged.

Herdr is asked for the pane's process twice, before and after its locks are read. The answer
stands only when both name the same single Agy process and its birth identity did not change in
between, so a process that took over an exited Agy's pid is never read for the pane. The greeting
of an Agy that has begun no conversation is checked the same way, its arguments included.

Linux process/lock discovery and native lifecycle behavior were tested with Agy 1.3.3.
macOS uses `lsof` for the same held-file evidence but has not been tested natively.
Its `ps` process-birth check has one-second resolution; same-second PID reuse is not distinguished.
Windows has no `/proc` and no `lsof`, so the same held-file evidence is asked of the documented
Restart Manager: `RmGetList` names the processes using a presence lock, and only the pane's own Agy
process is accepted. Windows process/lock discovery was tested with Agy 1.3.3 and Herdr 0.9.5, and
the native Windows CI suite checks file holders and executable names.
Discovery scans up to 4,096 presence locks, yielding between synchronous `RmGetList` calls.
A resolved pane re-validates its own lock with one call per refresh and rescans at least once a
minute, or sooner when another pane's scan shows its process holding more than that lock.
Missing or ambiguous holds retry with a per-process backoff from five to 60 seconds; a changed
presence listing resets the backoff. A `/new` or `/resume` that moves the hold is found on a
subsequent scan. An overflowing listing keeps Terminal rather than accepting incomplete evidence.
A process whose creation time cannot be read keeps Terminal, as a reused pid cannot pass for the
owner. A remote machine runs the
reader on that machine, beside its agent store.

Missing or ambiguous identity and unreadable stores use the existing terminal fallback.
An identified idle session with an empty database can show empty Chat before the ledger
exists. Until the ledger exists, discovery uses the monitor’s two-second retry; catalog
change notifications start after resolution. A new process without a conversation lock
still uses Terminal. A cold scan reads
up to 32 MiB per poll and resumes on the next poll; individual records are limited to
16 MiB and active history to 100,000 steps. Malformed complete step records use Terminal;
an incomplete final line waits for its newline. Rebuilding an evicted transcript index
invalidates its old cursors rather than reusing forgotten history state.

The database and export are written separately. The reader checks active indices around
each read and remembers observed removals, but does not claim an atomic database/export
snapshot or detect a rewind-and-regrow completed entirely before its first observation.
Eviction or rebuilding of the bounded index also forgets observed removals: if the database
has already regained an index but its replacement ledger row has not arrived, old ledger
text can briefly reappear. A new history ID invalidates old cursors but does not remove
that cross-file lag window. No persistent retirement state or database payload decoding
is used.

Validation covers fictional parser/paging fixtures, the conversation and whole-output
HTTP endpoints on an isolated Herdr server, and replay of an owned native conversation
through the production reader after saved rewind and restart. Native manual checks also
covered `/new`, `/resume`, repeated rewind, graceful restart and one crash while working.
These are bounded checks, not a guarantee about every Agy version or crash timing.
