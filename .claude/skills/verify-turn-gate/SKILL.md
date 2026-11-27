---
name: verify-turn-gate
description: Check a change to the chat queue's turn gate against the rule that the next queued message is typed on its own only after the turn of the message before it was seen to start and to finish. Use when a change touches the gate in server/pending-input.ts (gates, next, claim, committing, settle, confirmRecorded, apply, status, observe, baseline, mark, expire, hold, holdPane, move, forget, resend), what feeds it in server/core/pending.ts (drainPending, dispatchPending, dispatchPendingText, reconcileCodexDeliveries, the submit and pending-action frames) or server/core/status.ts (a pending.status call, deliverySnapshot, clientSnapshot, onBaseline), the Escape of a Codex Send now in server/codex-steering.ts, or the order of status events and snapshots in server/collector.ts and server/completion.ts.
---

# Verify the queue's turn gate

A chat message queued for an agent is typed later, by the server, when the agent's turn ends. herdr
reports a turn's start some time after its Enter, so "the agent is at rest" is true for a moment
after every send. The turn gate of `PendingInputs` (`server/pending-input.ts`) covers that moment:
once an Enter is committed, the queue gives out no further message until statuses that came after
that Enter have shown the turn to start and to finish. A break types the next queued message into
the turn the previous one started, where the agent takes it as a mid-turn steer or merges it into
the wrong turn, and nobody pressed anything.

The gate is changed by a dozen methods, and status events, a page leaving, the pane ending or
moving, the start timeout and a Send now can land between any two of their calls. Tests cover a
few of those orders. This check covers every order within its bounds.

## The rules

| Rule | What it says | What a break does |
| --- | --- | --- |
| `QueueWaitsForTurnEvidence` | From the `committing` of an Enter on, the queue is offered no message of that pane until readings of the agent made after that commit have shown the turn to start and then to finish: ready after work for an Enter that joined a turn at work, and ready, work, ready after the Escape of a Codex Send now. A reading is a status event, a snapshot's status that no event overtook, or the last read of a later send. One made before the commit, or before a reading already counted, says nothing of the turn. The wait may end without that only where no message of the pane is left queued, in the step that ends it: the start timeout, the pane ending or moving. Where the agent itself tells a turn's end (a Codex on the server Ovis started for it: the turn `turn/start` answered with, or one that server says its thread runs), the queue is offered nothing until that end is told or can no longer be told. Told, it ends the wait of the Enter that turn was taken as, and of every Enter before it, as the server ran no turn when it took the message. No longer told, the turn's wait is by the readings again, also for a turn the queue did not start. A start timeout that passes while that end is awaited is judged once the wait is over. | The queue takes up the next message on the strength of a status that says nothing about the turn before it. |
| `NoAutomaticEnterIntoQueuedTurn` | The queue's own Enter never reaches the agent while the agent is on, or has yet to begin, the turn of a message this queue sent before it. | The message lands in that turn: steered into it, queued behind it by the agent, or merged with it. |

The first rule is about the class and its callers, and is also asked with no description of the
agent at all: any status at any time. The second is the harm itself, and needs a description of
the agent and of herdr: see [what the check assumes](#what-the-check-assumes). A break of the
first is an early offer; whether a key follows depends on the queue's own reads of the pane before
its paste and before its Enter, which the second rule takes into account.

## Does your change touch it

Run `.claude/skills/verify-turn-gate/covered.sh`. It lists the covered files that differ from the
state the check was last confirmed against, committed or not, and exits 1 when any does. Then look
your change up in the [coverage record](#coverage-record): a change inside a listed function, a new
call of a `PendingInputs` method that reads or changes `gates`, `statuses` or `events`, a new
`await` between two listed calls, or a new source of `pending.status` is covered. A change
elsewhere in those files (leases, Pi receipts, omp's start, agent screens, alerts) is not.

## Run the check

```
bun .claude/skills/verify-turn-gate/check.ts
```

Since #4118 the main runs ask with every order the fixed findings put back, and take from ten minutes
(`gate-two-pages`) to over half an hour (`turns-claude`, near eighteen million states; `turns-codex` and `turns-ahead` ask with two messages, as three ran past fifty million and out of memory)
on a loaded P620: start them side by side, one `check.ts <run>` each, on a quiet machine. It prints one line per run. It is back where it should be when
every line starts with `ok` and it exits 0:

| Runs | What they ask | Must say |
| --- | --- | --- |
| `gate`, `gate-two-pages` | `QueueWaitsForTurnEvidence`, with any status applied at any time and any read saying anything | holds |
| `gate-served` | the same, with a Codex on the server Ovis started for it, which answers anything at any time | holds |
| `turns-claude`, `turns-codex`, `turns-moved` | both rules, with the agent and herdr [as described](#what-the-check-assumes) | holds |
| `turns-served` | both rules, with a Codex on the server Ovis started for it [as described](#what-the-check-assumes) | holds |
| `turns-ahead` | `NoAutomaticEnterIntoQueuedTurn`, with a snapshot ahead of status events put back | holds |
| `turns-other-turn` | `NoAutomaticEnterIntoQueuedTurn`, with a turn something else starts | holds |
| `broken-*` (eleven) | one rule each, on a copy of the class with one edit (`VARIANTS` in `explore.ts`) | that rule breaks |
| `finding-*` (one) | one rule, with one thing the real system does put back | that rule breaks: [what it has found](#what-it-has-found) |
| `limit-*` (two) | `NoAutomaticEnterIntoQueuedTurn`, with one thing status evidence cannot tell put back | it breaks: [known limits](#what-the-check-assumes) |

`bun .claude/skills/verify-turn-gate/check.ts <run>` runs one of them and, when a rule breaks,
prints the shortest path to the break: each step in plain words, and after it the agent, herdr's
reading, the queue's status, the gate and the rows. A line that says `WRONG` is a run that did not
say what it must, with its path. A `finding-*` run can name steps its path must take, in order
(`via` in `check.ts`), so that another order breaking the same rule does not pass for it: the
search goes on past a break without them, and the run is `WRONG` only when no break takes them.

The `broken-*` runs write a patched copy of `server/pending-input.ts` to the temp folder and
delete it. On this PC give the command a `TMPDIR` under `~/.cache/ovis-tmp/`, as AGENTS.md says of
`/tmp`. Run it after every change to the covered code or to `explore.ts`. A `broken-*` run that
stops breaking means the check no longer asks that rule; one that says its text is not in the file
means the code it edits changed: bring the variant up to date. `VTG_STEPS=1` before the command
lists how often each kind of step was taken (a kind that never is has become unreachable), and
`VTG_PROGRESS=1` prints the state count as a run goes.

There is no TLA+ model here, so the pstack `/statechart` skill has nothing to read: `check.ts`
prints its own paths.

## What is real code and what is described

- **Real.** The class. `explore.ts` imports `PendingInputs` from `server/pending-input.ts` and
  every step calls its methods. Nothing of `next`, `claim`, `committing`, `settle`, `apply`,
  `observe`, `expire`, `hold`, `holdPane`, `move`, `forget` or `resend` is written twice.
- **Described: the callers.** Which methods are called in which order, and where an `await` lets
  something else in, is copied from `server/core/pending.ts`, `status.ts`, `server-core.ts` and
  `server/codex-steering.ts` into the steps of `explore.ts`. The [coverage record](#coverage-record)
  names the code of each step.
- **Described: the agent and herdr.** What an agent does with an Enter, when herdr reads it, and
  when a status event, a snapshot or a reconcile's baseline reaches the server. Only the `turns-*`,
  `finding-*` and `limit-*` runs use it.
- **The rule's own record.** `explore.ts` keeps, beside the class and without reading a gate, which
  Enters were committed and which readings came after each (`waits`, `evidence`, `committed`,
  `handOver`, `timedOut`).

Why an explorer and not a model: the class is synchronous and has no I/O, so a model of it in
another language would be a second implementation to keep in step with the first. No verifier runs
on TypeScript. The explorer is a model checker's search with the real class as its step function:
breadth first over every step that can come next, each state saved as the class's fields plus the
described parts, a state seen before not expanded again, so a rule that holds holds for every
order within the bounds and a break comes with its shortest path. The described parts are a
dozen small variables, which is why they are enumerated in the same search.

## Tell a real bug from a wrong check

When a run that must hold breaks, go through its path step by step:

1. Find the step in the [coverage record](#coverage-record) and open the code it names. Can the
   code take that step in that state, with those arguments? A step the code cannot take is a wrong
   check.
2. Is the step one stretch of code with no `await` on I/O in it, and are two steps the path puts
   an event between really split by one? Code between two `await`s is one step.
3. For a `turns-*` run, is each thing the agent and herdr do in the path something they do? A
   path that needs what a `finding-*` or `limit-*` run puts back is one of those, not news.
4. For `QueueWaitsForTurnEvidence`, is the record right to wait? It counts a reading only when it
   was made after the commit and not before one already counted. A path in which the turn did
   start and finish, by readings the record refused, is a wrong check.
5. Play the path on the real code. For the class alone: `new PendingInputs(() => {})`, then the
   calls of the path, then `next(pane)`. For the callers too, `server/core/pending-left-lease.test.ts`
   shows the harness: `createPendingDelivery` with a fake `sight`, `clientSnapshot` and
   `serialize`, `spyOn` for `paneSendText`, `paneSendKeys`, `paneRead` and `paneProcessInfo` (have
   the spies ask the guard they are given, as `herdrRpc` does). Apply a status event as
   `status.ts` does, `delivery.pending.status(pane, status)` then `delivery.drainPending(pane)`,
   and do it inside the `paneSendKeys` spy to place it right after an Enter. Queue with
   `pendingFrames.submit` (`delivery: "queue"`), press Send now with
   `pendingFrames["pending-action"]` (`action: "steer"`), and read what was typed from the spies.
   For the status hub, `server/core/status.fake.ts` gives `hub(undefined, pending)` with a real
   `PendingInputs`, its `handlers`, and `originalCollector` to run the real collector on a faked
   subscription and snapshot.

The replay must end in what the broken rule names, not only take the path's steps: `next(pane)`
gives a message for `QueueWaitsForTurnEvidence`, and the queue's Enter is typed for
`NoAutomaticEnterIntoQueuedTurn`. An early offer is not a typed key (the baseline finding below
is the first without the second), so report which of the two the code did.

A path the real code follows to that end is a bug: report it with the path, and leave the rule and
the check as they are. A path it cannot follow, or one whose steps it takes without that end, is a
wrong check: correct the step, then run everything again.

## When you change the covered code on purpose

1. Change the steps of `explore.ts` that stand for the code you changed, so that they call the
   class as the new code does. Keep one step per stretch of code without an I/O `await`. A new
   caller of `committing` also calls `committed` (the rule's record), a new way to apply a status
   calls `evidence` with when it was read, and a new way to end the wait calls `handOver`, which
   ends it only when no message of the pane is left queued.
2. Run the check. A `gate` or `turns` run that breaks is your change, or your edit of the check:
   see above.
3. Each `broken-*` run must still break its rule. A variant whose text left the file gets the new
   text. A new rule gets a variant and a run of its own.
4. If your change fixes a finding, its `finding-*` run stops breaking and the check says `WRONG`.
   Move what that run puts back (`lateEvents`, `steerPastEnd`, `sendNowDuringRestart`, `baseline`
   or `atOnce` in `check.ts`) into `described`, so the main runs ask the rules with it, and delete
   the run and its paragraph below. Then run the whole check again: the main runs now ask more
   than they did in step 2.
5. Update the coverage record, then run `.claude/skills/verify-turn-gate/covered.sh --record` and
   `bun scripts/verify-turn-gate.ts --record`, and commit `covered.blobs` and `pins.json` with your
   change: that moves the sync commit and updates the targeted AST pin checked by
   `scripts/verify-turn-gate.test.ts` in `bun run check fast`. Do it only after you have read the
   covered functions as they are now and confirmed that the steps describe them, never to make
   `covered.sh` or `verify-turn-gate.test.ts` quiet. `--record` reads the files as they are in the
   working tree, so commit those same versions: on the clean tree after the commit, `covered.sh`
   must say that no covered file changed.

Never weaken a rule, the rule's record or a bound to make a run pass. When the product should
behave differently, say so to the maintainer first.

## What it has found

The check found five orders (#4118). Four are fixed, and what their runs put back is now part of
what every run asks (`described` in `check.ts`): a Send now's Enter that arrives after the turn it
read at work has ended (a ready right after it no longer ends the wait: it waits for that Enter's
own turn, `joined` and `lenient` in the gate); a Send now pressed while an earlier one's Codex
restart has not been seen to start (it keeps that restart's wait); a reconcile's baseline (never
turn evidence: `PendingInputs.baseline`, and not told at all for a pane with an event since the
snapshot was asked for); a message sent to the queue behind an open wait (`waiting` counts the
gate, so it is queued behind it). Their replays are `server/core/pending-turn-gate.test.ts`.

- **Status events that arrive late** (`finding-late-status-events`, #4118 case B, open). A
  snapshot can answer ahead of events herdr sent before it (`server/collector.ts` says so), and an
  event of the turn before can then pass for the turn the queue's Enter started. No herdr event
  carries its order against a snapshot, so the gate cannot tell such an event from one of the new
  turn. #4143 took every event as older than a snapshot reading that differed from it, until the
  event telling that reading came; herdr sends none for a change it made before a pane's
  subscription started, and the queue held under CI load (#4158). The class keeps no reading ahead
  of the events now, and B waits for an order herdr's events carry.

The `served` runs found two orders while the queue learned to wait for a turn's end Codex's own
server tells, both closed in that change. A queued message that server said waits behind a running
turn went by herdr's status alone once the server could no longer tell that turn's end: a turn the
queue did not start has a wait of its own now (`awaitTurn`), judged by the readings from then on.
And a Send now's start timeout that passed while such an end was awaited held nothing, as nothing
was queued yet, so a message queued behind it afterwards was typed into that Send now's turn: the
timeout is judged once the awaited end is told or lost (`expire`), and holds what was queued since.

A baseline asked before the Enter whose turn is awaited is no turn evidence: the gate still waits
for that turn's own start and end, and its start timeout holds what is queued if none comes, never a
key typed into a turn and never a wait with no end.

## What the check assumes

- **Bounds.** One pane, and in `gate-two-pages` and `turns-moved` the id it gets when herdr moves
  it once. Three messages from one page, or two messages from two pages in those two runs, each
  sent to queue or to hold. One time the agent stops to
  ask. One reconcile. Status events, Send now, Discard, a held copy sent again, pages leaving, the
  terminal restarting, the pane ending and the start timeout are not bounded.
- **One step.** Code between two `await`s on I/O is one step. One pane's lane runs one task at a
  time (`serialize`), and a task starts when the lane is free; status events, `expire`, a page
  leaving and the pane ending or moving come between any two steps.
- **Time.** The start timeout passes all at once, at any point after a commit; the 100 ms timer
  also runs with no time passed. Clock values, event counts and the order of readings are kept
  only as far as they compare. herdr's rest is `idle` in some runs and `done` in others.
- **What is saved of the class between steps.** Its rows in order (owner, pane, state, on its way,
  overtaken by a move), `statuses`, `events`, and `gates` (with `joined` and `lenient`). Not saved, because no step here reads
  them: the outcomes of rows that are gone (`removed`), held-copy sends once settled (their row is
  then gone or uncertain, and no step sends that copy again), a row's fault and times. A new step
  that reads one of these must save it.
- **After `committing`.** A send that fails after its paste is settled uncertain (`wrote` in
  `dispatchPendingText`). A change that settles it any other way is a new step.
- **The agent and herdr, in the `turns-*` runs.** The agent is at rest or on a turn, and may stop
  to ask. An Enter that reaches it at rest starts a turn; one that reaches it at work joins that
  turn; Codex shows a Send now's Enter in its steering panel until it takes it into the turn or
  Escape interrupts the turn, after which it starts a turn with it. herdr reads the agent's state
  at any later time, missing states in between, and sends a status event per change, naming the
  pane's id at the time, applied in order at any later time. A snapshot says herdr's reading, or
  the status of an event applied during the read.
- **A Codex on the server Ovis started for it, in the `served` runs.** A send asks that server before it
  types. The server knows what its thread does with no delay: it takes a message as a turn only while
  the agent is at rest, with no status event still on its way at that commit, and its answer comes
  in a later step, or never. On a turn it takes nothing and says so. It tells the end of the turn the
  queue waits behind only once the agent has ended that turn, and its connection can end at any
  time before. Where it answers neither, the message is typed as in every other run, so these runs
  ask the rules with both ways of sending. They ask with two messages and no stop to ask.
- **Asked in the main runs since #4118.** A Send now's Enter that arrives after the turn it read at
  work has ended; a Send now pressed while an earlier one's Codex restart has not been seen to
  start; a reconcile's baseline; a message typed at once behind an open wait counted as the
  queue's.
- **Left out of the main runs because a rule breaks with it.** What `finding-late-status-events`
  puts back: a status event still on its way at a read of the pane (the snapshot is then ahead of
  it), at a `committing`, at the user's next action or at the start timeout. With a snapshot ahead
  of events alone, the queue can be offered a message early and yet no Enter of its own follows
  (`turns-ahead`).
- **Known limits of status evidence** (`limit-*`). The gate counts whichever statuses come after
  `committing`. It cannot tell them from the turn its Enter started when the agent or herdr
  changes between `committing` and the Enter's arrival (`limit-slow-enter`), when an Enter that
  arrives during a turn waits in the agent's own queue past that turn's end and runs as a turn of
  its own (`limit-own-queue`). A turn something else starts (typing at herdr's terminal, a turn the
  agent resumes by itself) was a third, through a Send now whose steering wait that turn's end
  completed; since #4118 that ready waits for the Send now's own turn, and `turns-other-turn` holds
  with such a turn. Also assumed: the agent begins a turn it
  has in its own queue, and herdr reads a turn's start, well within the 10 s start timeout. After
  that timeout the wait is over, and a message queued later goes by herdr's status alone.
- **What the first rule does not ask.** It takes the last read of a later send as a reading of the
  agent, as the gate does (a steering `committing` starts with work seen). It ends a wait when no
  row of the pane is left queued, and does not ask that those rows were held rather than dropped.

## Not covered

- Whether Codex's server tells the end of the right turn (`Connection` in `server/approvals/codex.ts`,
  by the pane's own thread and the turn's id: its tests). The check takes a told end as that turn's.
- Whether the status the queue is told is right: herdr's detection, `CompletionTracker`,
  `restingClaude`, `queueStatus` and `queueHeld` (a Claude that rests on a background subagent or
  resumed a turn by itself), OmO, GJC and Letta. The check takes the status given to
  `pending.status` and the one a snapshot shows as herdr's reading.
- Statuses that are not herdr's event stream in order, apart from a reconcile's ready baseline: a
  baseline that reads the agent at work (it re-tells what the tracker last recorded), a resync
  after lost events and a replay (both reach the queue through `pending.baseline` as a reconcile's
  baseline does: `server/core/pending-turn-gate.test.ts` plays them on the real collector), the
  idle told when a finished pane is focused, the transcript's
  late verdicts (`claudeLate`, `codexRest`), `tellQueue`. The `gate` runs cover them as far as the
  class goes (any status at any time); the `turns-*` runs do not describe them.
- A pane's first message (`FIRST_MESSAGE_OWNER`, `holdItem`, `rehold`), omp's start
  (`waitingFor`, `holdQueued`, a message queued behind a starting omp with no `observe`), ACP child
  sessions (`acp:`, whose single-step `committing` and Send now `observe("working", mark)` call the
  same `PendingInputs` methods), a message for an agent alone, Grok's second Enter after a Send now,
  agy's alt+m after a Send now (it joins the turn at work, so it arms no restart: `SEND_NOW` in
  `server/codex-steering.ts`), Pi's receipt.
- `close` and the 60 s after it (a closed owner's rows are held first, then dropped). The
  bookkeeping of `resend` around a Send now (a repeated request gets the first one's answer): read,
  not explored. A held copy sent again is explored, as one step, for a row still listed.
- A frame that already waits in the lane behind another, and what it captured before it got
  there. A pane id herdr gives to another pane. A pane moved twice, or onto an id in use.
- Explicit sends. A Send now or a message typed at once may land in any turn: that is the user's
  choice, and no rule here is about it (but see the last finding).
- Whether a message is typed twice or after its page left (`verify-pending-lease`). Whether a
  held message stays held, or a row is dropped. Whether the queue ever goes on: a wait that never
  ends breaks no rule here.
- Several panes. More than three messages. Whether the check matches code that changed since the
  sync commit.

## Coverage record

Sync commit: the commit that last changed `covered.blobs` in this folder (`covered.sh` prints it).
That file holds the git blob id of each covered file as it was when the check was last confirmed
against it. A squash merge keeps blob ids, so the record stays right on `main`.

| Step in `explore.ts` | Code |
| --- | --- |
| every call on `inst` | `server/pending-input.ts` `PendingInputs`: `enqueue`, `next`, `claim`, `committing` (with the read's mark), `typedAtOnce`, `awaitTurn`, `turnOver`, `settle`, `confirmRecorded`, `discard`, `mark`, `current`, `status`, `observe`, `baseline`, `waiting`, `forget`, `hold`, `holdPane`, `move`, `expire`, `resend`, and the private `apply`, `read`, `finish`, `finished` and `blocksQueue` (an uncertain row kept for review alone, `reviewOnly`, does not stop the queue) they reach |
| `status event applied` | `server/core/status.ts`: `pending.status(paneId, …)` and the `drainPending` after it, in `reportStatus`, `omoChanged`, `gjcChanged` |
| `a reconcile reads the pane`, `the reconcile's reading is told to the queue as its baseline` | `server/collector.ts` `reconcile` (`await deps.snapshot()`, then `handlers.onBaseline` with the panes that had an event since it was asked for; `created` is for web push alone); `status.ts` `onBaseline`, `pending.baseline` for the others |
| `… reads the pane`, `… has read the pane` | `server/core/pending.ts` `pendingContext`, `currentIdentity`; `status.ts` `deliverySnapshot` (handed to `createPendingDelivery` in `server-core.ts` as `clientSnapshot`); `server/completion.ts` `readSnapshot` (an event applied during the read wins) |
| `sends … to queue / hold`, `accepted to … (observe, enqueue)`, `Codex's questions are collapsed`, `typed at once` | `pending.ts` `pendingFrames.submit`, the `waits` branch: `pending.mark`, `pendingContext`, `pending.observe`, `pending.enqueue`, and its `dispatchPendingText(…, queued)` whose `committing` is `pending.typedAtOnce` |
| `the queue takes up`, `claimed by the queue` | `pending.ts` `drainPending`: `pending.next`, `pending.claim(item, true)` |
| `the queue reads the pane (mark taken)`, `put off (observe …)`, `put off with no status told`, `refused before the paste`, `a screen of Codex's own has the input`, `pasted` | `pending.ts` `dispatchPendingText` up to its paste: `pending.mark`, `pendingContext`, `pending.observe(paneId, "working" / "blocked", mark)`; `dispatchPending`: `retry`, `left`, `pending.settle`, and `pending.holdPane` for an `unannounced` refusal |
| `reads the pane before its Enter`, `committing (…)`, `its Enter lands`, `refused after the paste: uncertain`, `sent` | `dispatchPendingText` from its paste on: `enterMark`, `beforeEnter`, `steering`, `committing(steering, false, enterMark)`, `paneSendKeys`, the `catch` that makes every failure after `wrote` a `submit_changed`; for a Codex at rest on the server Ovis started, in the runs without `served`, `sendCodexTextAsData`'s `mayWrite`, whose `committing(false, false, pending.mark(paneId))` comes right before turn/start stands for the Enter (its mark is taken later than `enterMark`, so fewer readings count); `dispatchPending`'s `pending.settle` |
| `committing (a turn to start); the request reaches Codex's server, at rest`, `typed at once as a turn, the request reaches Codex's server`, `Codex's server answers with the turn: sent, the queue waits for that turn's own end`, `Codex's server's answer is lost`, `Codex's server says its thread runs a turn: put off / queued behind that turn's end`, `Codex's server tells / can no longer tell the awaited turn's end` | `pending.ts` `dispatchPendingText`, the branch for a Codex on the server Ovis started (`sendCodexTextAsData`): `mayWrite`'s `committing(false, false, pending.mark(paneId))` or `pending.typedAtOnce` right before turn/start, then the awaited answer; `behindCodexTurn` (`pending.awaitTurn`, and `pending.turnOver` then `drainPending` when the turn's `over` settles) for a `started` turn and, for an automatic send or one sent to the queue, a `running` one with its `pending_wait`; the `submit_changed` of an answer that never came. `server/approvals/codex.ts` `Connection.startTurn`, whose last look at its thread and whose request are one stretch |
| `Send now on`, `Send now refused before it began`, `claimed by Send now` | `pending.ts` `pendingFrames["pending-action"]`, action `steer`: `pending.claim(item, false)`, and the claim and settle of a send refused before its claim |
| `Send now reads the pane for Codex's app server`, `Send now checks Codex's loaded threads`, `refused before Codex's steer`, `Codex's loaded threads changed`, `Codex's app server leaves the send to the terminal`, `committing (steering via Codex's app server)`, `Codex's app server confirms the steer`, `Codex's app server reply is lost` | `pending.ts` `dispatchPendingText` `steerTarget.send` (`server/approvals/codex.ts` `Connection.steer`): `steerMark` before `pendingContext`, `thread/loaded/list`, `pending.holdPane` on `"changed"`, fallback to terminal path without `nativeItem` on `"unsent"`, `committing(true, false, steerMark)` before `turn/steer`, then `"accepted"` vs `"unknown"` |
| `Send now reads the pane for Codex's steering panel`, `the panel shows it: committing (restarting the turn)`, `Escape lands`, `Codex is no longer at work`, `the restart is not confirmed`, `Codex reads at rest / at work after the Enter` | `server/codex-steering.ts` `interruptCodexSteering` (its `"unconfirmed"` answer, and the read after an Enter typed while Codex was at rest), `codexSteeringPending`, `SEND_NOW`; `pending.ts` its `read`, `restarting` and `press`, with the guard on `pending.current`, and `keepTurnGate`, which `dispatchPending` settles as `settle(…, "preserve-turn")` |
| `native transcript confirms it (confirmRecorded)` | `pending.ts` `reconcileCodexDeliveries`: `pending.confirmRecorded` inside `serialize` |
| `a saved copy of … is sent again` | `pending.ts` `pendingFrames.submit` with a `resend_id`; `PendingInputs.resend` and its reply handler |
| `Discard` | `pending-action`, action `discard`: `pending.discard` |
| `…'s page leaves the pane` | `pending.ts` `holdPending` (also from `terminals.ts` `retireFit`, `fitHeld`, `fitPane` when a native Windows terminal's control moves), `pending.hold`, and the `pending.hold` in `pendingFrames.submit` right after `pending.enqueue` when the lease no longer authorizes (the page left during the submit's awaits) |
| `the pane's terminal restarts under its pages` | `pending.ts` `holdPendingPane`, `pending.holdPane` (including `server-core.ts` when an ACP child's status turns `unknown`) |
| `the pane ends` | `status.ts` `paneGone`: `holdPendingPane`, then `pending.forget` |
| `herdr moves the pane under a new id` | `pending.ts` `movePendingPane`: `holdPendingPane`, then `pending.move` |
| `the start timeout passes`, `the 100 ms timer runs expire()` | `server/core/server-core.ts` `start`: `pending.expire()` every 100 ms, and `drainPending` for each pane it returns; `PENDING_START_TIMEOUT_MS`. A wait the class ends then, for a deadline it had when the timeout passed, ends the rule's record's wait too where nothing is left queued (`expiredGate`) |
| one task per pane | `server/core/input.ts` `serialize` |
| `herdr reads the agent …`, a snapshot ahead of events | `server/collector.ts`: the status subscription, and `REPLAY_SETTLE_MS` on a snapshot overtaking events |
