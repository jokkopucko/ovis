---
name: verify-pending-lease
description: Check a change to pending chat messages (queued, held, a create request's first message) against the rule that nothing the user typed is sent after its page left the pane, closed or lost the terminal. Use when a change touches server/core/pending.ts, server/pending-input.ts or server/input-guard.ts, the create routes' first message in server/workspace-routes.ts, or how server/core/terminals.ts, terminal-process.ts, connections.ts or socket.ts end an attachment, a connection or the right to type.
---

# Verify the pending-message lease

A chat message that waits for the agent (queued for its next turn, held for Send now, or the first
message of a new workspace) is typed later, by the server, on the sender's behalf. It carries a
lease: it may be typed only while the connection it waits on is still attached to that pane's
terminal and may still type. A break types the user's words into a terminal they have left, types
them twice, or types them into whatever runs there by then.

The lease is checked at many `await` points, and the events that end it (a detach, a close, a
switch to watching, the attach restarting) can land between any two of them. Tests cover a few of
those orders. This check covers every order, in a TLA+ model of the lease, with the TLC model
checker.

## The rules

| Rule | What it says | What a break does |
| --- | --- | --- |
| `NoTypingAfterLeaseLoss` | Nothing of a message is pasted or entered after the connection it waits on left the pane, closed, switched to watching or lost the terminal's attach, also when that connection has come back since. For a first message, the attach restarting ends the send under way, not the message's turn: its page may type it at a later try. | The message is typed with nobody there who asked for it. |
| `FirstMessageOnlyByItsPage` | A first message is typed on its own only through the page that sent the create request, and never once that page has left the pane, closed or switched to watching since the request came, also while the workspace was made and the agent launched. | Another device, or a page that returned, types it unasked. |
| `TypedAtMostOnce` | A message is pasted once and gets one Enter of its own, whatever fails in between. One that went to the agent as data (an ACP prompt, Codex's `turn/steer` or `turn/start`) has had both: it is never typed as well, also when no answer to it came. (The keys a Send now presses after that Enter, Codex's Escape, agy's alt+m and Grok's second Enter, are not counted.) | The agent gets the message twice, or a half-typed message is typed again behind itself. |
| `FirstMessageHeldOncePageLeft` | A first message whose page left is held, not left waiting. | The pane's other queued messages wait behind it for ever. |
| `LostLeaseStaysHeld` | A queued message whose sender left is held: its row never says it still waits for the agent's turn. | The row looks armed when it is not. |
| `QueueWaitsForToldTurnEnd` | While the queue waits for a turn's end the agent itself tells (a Codex on the server Ovis started: `turn/completed` for the turn `turn/start` answered with, or for one that server says the thread runs), it types nothing on its own: no queued message, and none sent to the queue and typed at once. A Send now is the user's own. | The next message is typed into the turn the one before it started. |

## Does your change touch it

Run `.claude/skills/verify-pending-lease/covered.sh`. It lists the covered files that differ from
the state the model was last confirmed against, committed or not, and exits 1 when any does. Then
look your change up in the
[coverage record](#coverage-record): a change inside a listed function, or one that adds a new way
to type a pending message, to end an attachment or connection, or to take the right to type away,
is covered. A change elsewhere in those files (Pi receipts, the turn gate, agent screens) is not.

## Run the check

The model is `PendingLease.tla` in this folder. Read every result with the pstack `/statechart`
skill (`/pstack:statechart` in Claude Code): give it `PendingLease.tla`, the config
`PendingLease.cfg` and the view `view.ts`, and a new output folder outside the repo. `/statechart`
installs TLC and Java itself when `mise` is on the PATH. On this PC give it a `TMPDIR` under
`~/.cache/ovis-tmp/`, as AGENTS.md says of `/tmp`.

A run that is back where it should be says that the six rules above and `NoDeadlock` hold, over
4,709,805 states, in one to three minutes on 8 workers. The model has more states than `/statechart` draws, so a
passing run has no chart. A rule that breaks comes with its shortest path, in plain words, and a
chart of that path.

Without `/statechart`, TLC runs by itself and says the same in its own words (`Model checking
completed. No error has been found.`, or `Invariant <rule> is violated.` with the states of the
path). Copy this folder out of the repo first, as TLC writes beside the model:
`java -cp tla2tools.jar tlc2.TLC -workers 8 -config <config> -metadir <a folder outside the repo> PendingLease.tla`.

Each rule has at least one config that breaks the code it guards, to show that the rule can fail. Run them the
same way, each with its own output folder, after every change to the model. One that stops
breaking means the model no longer checks that rule.

| Config | The break | Rule that must break |
| --- | --- | --- |
| `broken-keep-authority.cfg` | `holdPending` does not delete the authority | `NoTypingAfterLeaseLoss` |
| `broken-retry-after-typing.cfg` | a send that failed after its paste is queued again | `TypedAtMostOnce` |
| `broken-keep-requester.cfg` | `holdRequested` keeps the page as the first message's typist | `FirstMessageOnlyByItsPage` |
| `broken-no-hold-on-leave.cfg` | `holdRequested` does not hold the first message | `FirstMessageHeldOncePageLeft` |
| `broken-requeue-lost-lease.cfg` | `dispatchPending` queues again a message that `hold` marked on its way | `LostLeaseStaysHeld` |
| `broken-list-after-leave.cfg` | `queueFirstMessage` lists a first message as queued though its page left since the request | `FirstMessageOnlyByItsPage` |
| `broken-type-unanswered-data.cfg` | a message that went as data and got no answer is typed instead, as one that reached nothing is | `TypedAtMostOnce` |
| `broken-drain-before-turn-end.cfg` | `next` gives out a message though a turn's end the agent tells is still awaited | `QueueWaitsForToldTurnEnd` |
| `broken-no-wait-for-turn.cfg` | the queue does not go behind the turn its message became (no `pending.awaitTurn`) | `QueueWaitsForToldTurnEnd` |

Each of these configs names its rule alone, because `/statechart` checks the other rules after a
break only up to a bound.

## Tell a real bug from a wrong model

When a rule breaks, go through the path `/statechart` reports, step by step:

1. Find the step's action in the [coverage record](#coverage-record) and open the code it names.
   Can the code take that step in that state? A step the code cannot take is a wrong model.
2. Is the step one stretch of code with no `await` on I/O in it? The model lets any event land
   between two steps. If the code runs both steps with no herdr call, timer or file read between
   them, the model split them wrongly.
3. Play the path on the real code. `server/core/pending.test.ts` shows the harness:
   `createPendingDelivery` with a fake `sight`, `clientSnapshot` and `serialize`, and
   `mock.module("../herdr/client.ts")` to record `paneSendText` and `paneSendKeys`. Make
   `clientSnapshot` wait on a promise the test holds: that is the `await` at which the test plays
   the path's event (`delivery.holdPending(client, pane)` is what `detach()` calls, and
   `delivery.holdPending(client)` what a switch to watching calls). Then read
   `delivery.pending.list(client, pane)` and the recorded writes.

A path the real code follows is a bug: report it with the path, and leave the rule and the model
as they are. A path it cannot follow is a wrong model: correct the action, then run the main config
and every `broken-*` config again.

## When you change the covered code on purpose

1. Change the actions that stand for the code you changed, so that the model describes the new
   code. Keep one action per stretch of code without an I/O `await`. A new event that takes the
   pane or the right to type from a connection also calls `Lose`, which is what the rules are
   stated on. A new way to type a pending message goes through `Write`.
2. Run `PendingLease.cfg`. A break here is your change, or your edit of the model: see above.
3. Run the nine `broken-*` configs. Each must break its rule. A new rule gets a `Break…` constant
   and a config of its own.
4. Update the coverage record, then run `.claude/skills/verify-pending-lease/covered.sh --record`
   and `bun scripts/verify-pending-lease.ts --record`, and commit `covered.blobs` and `pins.json`
   with your change: that moves the sync commit and updates the targeted AST pin checked by
   `scripts/verify-pending-lease.test.ts` in `bun run check fast`. Do it only after you have read
   the covered functions as they are now and confirmed that the model describes them, never to make
   `covered.sh` or `verify-pending-lease.test.ts` quiet.

Never weaken a rule or delete an event to make a run pass. When the product should behave
differently, say so to the maintainer first.

## What it has found

Three orders that tests had not reached, all fixed in the change that added this check, each with
tests (`server/core/pending-left-lease.test.ts`, and one at the create route in
`server/pending-input.contract.test.ts`) and a `broken-*` config that brings it back:

- A queued message whose sender left the pane during its automatic send went back to `queued`
  when that send was only put off (`agent_blocked`), so its row said it still waited. Nothing was
  typed.
- A first message was listed as queued, and later typed on its own, although its page had
  switched to watching and back while `queueFirstMessage` awaited herdr.
- The same during the minute the create route may take to launch the agent, before
  `queueFirstMessage` was called at all. A review of the first fix found this one: the model
  then started from a message already listed, and so assumed what it should have checked.

## What the model covers and assumes

- **Bounds.** One pane. Two connections, `a` and `b`; a reconnect is another connection. One
  message that `a` queues or holds, and at most one first message, asked by `a` or by `b`. `a`
  sends its message only once the first message is listed. One frame at a time waiting for the
  pane's lane. Attaches, detaches, attach restarts, mode switches
  and retries are not bounded.
- **One step.** Code between two `await`s on I/O is one step. A chain of `await`s on values that
  are already settled counts as one step too: no frame, timer or herdr reply runs inside it. A
  herdr write and the guard asked right before it are one step (`herdrRpc`'s `guard`).
- **Identities.** The code compares objects (the attachment, its process, the authority). The
  model keeps the answer of each comparison on the lease (`a`, `p`, `k`), which is the same thing
  and needs no bound on how many objects are made.
- **Where it starts.** With a create request that carries a first message just read by its route
  (`askFirstMessage`), or with none. The pane is there from the start. In the code herdr makes it
  a moment later and may tell pages of it before the route learns its id: what happens to it until
  then is kept on the request (`early`) and counted when the route names the pane (`at`).
- **Wider than the code.** The queue may take up a message at any time: the agent's status and the
  turn gate of `PendingInputs` are left out, except the wait for a turn's end the agent itself
  tells (`turnWait`, beside `toldTurn`, which says that the agent runs such a turn whatever the queue registered), which may be told, or become untellable, at any time. Every send may ask the
  agent's data channel, whatever agent it is, and get any of its answers: nothing went, it went
  and was taken, it went and was taken as a turn whose end will be told, it went with no answer,
  or the agent's own server says a turn runs. Every check on the agent (its process, session,
  screen) is a refusal that may come at any time. A mirrored pane may restart like a pty. These
  add orders the code cannot take, so a pass still holds for the code.
- **Folded into another step.** The keys a Send now presses before its paste to empty Claude's
  box (`freeClaudeBox`) and the several writes of a paste with skills (`typeWithSkills`) each ask
  the same lease as `Paste`: a write there without that guard is a new step that calls `Write`
  with no `Authorized`. An attach is one step: the claim a page has while its attach still waits
  on herdr is not told apart from membership. A detach then holds as one of a member does, and an
  attach that fails leaves no hold, which is a page that never opened the pane. A chat message
  sent at once that is queued after all behind a starting omp is a queue request (`Submit`) when a
  lease could be taken as its frame came: that lease is the one it keeps.
- **Not covered.** That a queued message waits for the turn before it to start and finish by the
  statuses herdr reads (the turn gate, `PendingInputs.apply`: `verify-turn-gate`), and what that
  gate does once a told turn's end can no longer be told. Whether Codex's server tells the right
  turn's end (`Connection` in `server/approvals/codex.ts`: its tests). Which agent, process or session a message is typed into. A
  pane that ends or moves, beyond its attachment closing (`holdPendingPane`, `movePendingPane`).
  Discard. A chat message sent at once to a pane that was not ready as its frame came, and is then
  queued behind a starting omp (`way = askFirstMessage(client.data.connectionId)` notes a leave
  meanwhile via `way.left`, then takes its first lease in the lane). A message sent at once and a
  held copy's resend (`resend_id`): both are a present
  user's own send, typed under `authorizeSocket` alone with no lease, by design; the resend also
  ends the record with that id as sent. A page that
  switches to watching and back while the server still reads its create request's body: the
  request counts from when the route has read it. Pi receipts and Codex transcript reconciliation
  (`reconcileCodexDeliveries` / `confirmRecorded`, which only consumes an already-uncertain row).
  Several panes, several queued messages of one connection, a remote PC's relay connection. What
  herdr or the agent do with the bytes. Whether the model matches code that changed since the sync
  commit.

## Coverage record

Sync commit: the commit that last changed `covered.blobs` in this folder (`covered.sh` prints it).
That file holds the git blob id of each covered file as it was when the model was last confirmed
against it. A squash merge keeps blob ids, so the record stays right on `main`.

| Model | Code |
| --- | --- |
| `Init`, `FirstListed`, `askLeft`, `askFault` | `server/workspace-routes.ts`, the create routes (`/api/workspace/create`, `/api/tab/create`: `firstMessages.ask` before the pane is made, `at`, `queue`, `end`); `server/core/pending.ts` `askFirstMessage`, `queueFirstMessage` (`ended()` after the last `await`, including `pinPiSession`) |
| `Authorized`, `CanLease`, `FactsNow` | `pending.ts` `authorizePending`, `pendingLease`; `server/input-guard.ts` `typingGuards.pendingLease`, `sightingFacts`; `server/core/terminals.ts` `sight`; `server/core/connections.ts` `authorizeSocket` |
| `HoldPending`, `Age`, `Unauthorize` | `pending.ts` `holdPending`, `holdRequested` (also called by `terminals.ts` `retireFit`, `fitHeld` and `fitPane` when a native Windows terminal's control passes to another viewer or is retired); `server/pending-input.ts` `hold`, `holdItem` |
| `Attach` | `terminals.ts` `terminalFrames.attach`; `server/core/terminal-process.ts` `spawnAttachment` |
| `Detach`, `Leave` | `terminals.ts` `terminalFrames.detach`, `detach` (including `drainingAttachments` on a graceful leave, after `holdPending` and `attachments.delete`) |
| `CloseAttachment` | `terminals.ts` `closeAttachment`, `closeAttachments` and their callers |
| `Took`, `Ended`, `Restart` | `terminal-process.ts` `took`, `ended`, `again`, `relookup`; `pending.ts` `holdPendingPane` (and `server-core.ts` when an ACP child's status turns `unknown`); `pending-input.ts` `holdPane` |
| `Observe`, `Interact` | `server/core/socket.ts` `role` |
| `Close`, `Revoke` | `socket.ts` `close`; `connections.ts` `end` (including `untilLock`); `pending.ts` `closeConnection`; `pending-input.ts` `close`; `terminals.ts` `detachClaimed`, `dropClaims` |
| `Submit`, `RequestRuns`, `AcceptRefused`, `AcceptEnqueue`, `AcceptHeld`, `AcceptTypeNow`, `TypeNowWaits` | `pending.ts` `pendingFrames.submit`, its `waits` (and ACP child) branch, with the `authorizePending` right after `pending.enqueue` and the `pending.hold` when it refuses; `pending-input.ts` `enqueue` |
| `SendNow`, `SteerRefused`, `SteerClaim` | `pending.ts` `pendingFrames["pending-action"]`, action `steer` |
| `DrainPick`, `DrainSkips`, `DrainClaim`, `DrainClaimNoLease`, `Typist`, `NextUp`, `CanClaim` | `pending.ts` `drainPending`, `typists`, `dispatchPending`; `pending-input.ts` `next` (with `turns`, the model's `turnWait`), `claim` |
| `RefusedForNow`, `RefusedForGood`, `RefusedHoldPane`, `LeaseFailed`, `FailedAfterPaste` | `pending.ts` `pendingContext`, `dispatchPendingText` (including `refusedFirstWrite`, Codex `unannounced` own-screen `holdPane`, and Codex app-server `"changed"` `holdPane`) and its `catch` |
| `Paste`, `SubmitAsData`, `Enter`, `LaterKey` | `dispatchPendingText`: `paneSendText` and `paneSendKeys` with the guard `allowed`, ACP `child.client.submit`, Codex `steerTarget.send` `writing` and `sendCodexTextAsData` `mayWrite` (turn/start for a Codex at rest) after `authorizePending`; the guarded writes of `server/core/composer.ts` `freeClaudeBox` and `server/opencode-skill-attach.ts` `typeWithSkills`; `server/herdr/client.ts` `herdrRpc` `writeRequest` |
| `DataUnsent`, `DataBusy`, `DataUnanswered`, `SentAsTurn`, `TurnOver` | the answers of `server/approvals/codex.ts` `Connection.startTurn` (`unsent`, a `running` turn, `unknown`, a `started` turn) and `steer` (`unsent`, `unknown`), as `server/command-data-send.ts` `sendCodexTextAsData` and `dispatchPendingText` take them: typed as before, `pending_wait` behind the turn for an automatic or queued send, `submit_changed`, sent; `pending.ts` `behindCodexTurn` (`pending.awaitTurn`, and `pending.turnOver` then `drainPending` once the turn's `over` settles); `pending-input.ts` `awaitTurn`, `turnOver`, `waiting` |
| `Settle`, `Unattended`, `LeaseFailRetries`, `Sent`, `SentUnconfirmed` | `pending.ts` `dispatchPending`, `FIRST_MESSAGE_RETRY_CODES`, `keepTurnGate` (a Codex Send now on the terminal that `interruptCodexSteering` calls `"unconfirmed"`); `pending-input.ts` `settle` (with `"preserve-turn"`: the state `review`, `reviewOnly`, which `blocksQueue` lets the queue pass) |
| the lane (`lane`, `req`) | `server/core/input.ts` `serialize` |
| who calls what | `server/core/server-core.ts`, where `createTerminalRegistry`, `createPendingDelivery` and `createConnections` are given each other's functions |
