---------------------------- MODULE PendingLease ----------------------------
(***************************************************************************)
(* The lease of a pending message: one pane, its terminal attachment, the   *)
(* connections on it, one message a connection queued ("Q") and one first   *)
(* message of a create request ("F").                                       *)
(*                                                                          *)
(* Every action is one stretch of code that runs without an `await` on      *)
(* I/O. Each names the code it stands for. SKILL.md beside this file lists  *)
(* what is covered, what is left out and how to read a result.              *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
  Clients,       \* the connections (Client objects); a reconnect is another one
  Sender,        \* the connection that sends Q
  \* Broken variants. All FALSE is the code as it is.
  BreakKeepAuthority,     \* holdPending keeps the authority
  BreakRetryAfterTyping,  \* a send that failed after its paste is queued again
  BreakKeepRequester,     \* holdRequested keeps the page as the first message's typist
  BreakNoHoldOnLeave,     \* holdRequested does not hold the first message
  BreakRequeueLostLease,  \* dispatchPending queues again a message hold() marked on its way
  BreakListAfterLeave,    \* queueFirstMessage lists a first message as queued though its page left since the request
  BreakTypeUnansweredData,  \* a message that went as data and got no answer is typed instead, as one that reached nothing is
  BreakDrainBeforeTurnEnd,  \* next() gives out a message though a turn's own end, told by the agent, is still awaited
  BreakNoWaitForTurn        \* the queue does not go behind the turn its message became (no pending.awaitTurn)

VARIABLES
  \* server/core/terminals.ts and terminal-process.ts: the pane's attachment
  att,        \* attachments.has(pane)
  alive,      \* attachment.process has not ended
  ready,      \* attachment.ready
  held,       \* attachment.held: another bridge has the terminal
  members,    \* attachment.clients (a member also has the pane in client.data.attached)
  \* server/core/connections.ts
  conn,       \* "open", "revoked" (ended, its close event not yet handled), "closed"
  mode,       \* "interact" or "observe"
  \* server/core/pending.ts and server/pending-input.ts
  st,         \* the message's state; "none": not accepted; "asked": a first message's request has come and
              \* it is not listed yet; "lost": typed with no record kept
  fl,         \* PendingRecord.inFlight
  lease,      \* PendingRecord.lease of Q
  laneLease,  \* the lease the send in the lane checks
  reqLease,   \* the lease the waiting frame took
  order,      \* the records in the order they were accepted
  page,       \* the page connection whose create request carried F
  requester,  \* requesters.get(F), or "none": the page, until it leaves
  askLeft,    \* the request's `left`: holdRequested found the page leaving before the message was listed
  askFault,   \* the request's `fault`: holdPendingPane found the pane's terminal restarting before then
  lane,       \* what runs in the pane's serialized lane (serialize), or NoLane
  req,        \* a frame that took a lease and waits for the lane, or NoReq
  turnWait,   \* PendingInputs.turns has the pane: its queue waits for a turn's end the agent itself tells (awaitTurn)
  toldTurn,   \* the agent runs a turn whose end it will tell, and can still tell it: what turnWait should know of
  \* what the rules are stated on; no code reads these
  armed,      \* the sender has not left since it queued Q
  pageOk,     \* the page has not left since its request
  laneIntact, \* who types in the lane has not left since the send was asked for
  reqIntact,  \* who sent the waiting frame has not left since
  pastes, enters,
  typedAfterLoss, firstWithoutPage,
  behindTurn  \* the queue itself wrote while a turn's end was awaited

terminal == <<att, alive, ready, held, members>>
leases == <<lease, laneLease, reqLease>>
counts == <<pastes, enters, typedAfterLoss, firstWithoutPage, behindTurn>>
first == <<page, requester, askLeft, askFault>>
vars == <<terminal, conn, mode, st, fl, leases, order, first, lane, req, turnWait, toldTurn,
          armed, pageOk, laneIntact, reqIntact, counts>>

Msgs == {"Q", "F"}
(* A lease is a sighting (the attachment and its process as seen, terminals.ts sight) and an authority object.   *)
(* The code compares identities; the model keeps what each comparison would answer: the attachment seen is still *)
(* the pane's (a), its process is still the one seen (p), the authority is still the connection's (k). A        *)
(* connection's leases share one authority (pendingAuthorities), made when it has none, so a new lease is Fresh  *)
(* and deleting the authority ends every lease the connection took before.                                       *)
Fresh == [a |-> TRUE, p |-> TRUE, k |-> TRUE]
Dead == [a |-> FALSE, p |-> FALSE, k |-> FALSE]
NoLane == [m |-> "none"]
NoReq == [kind |-> "none"]
Gone == {"none", "asked", "sent", "lost"}
Min(x, y) == IF x < y THEN x ELSE y

\* connections.ts authorizeSocket: a revoked or watching connection may not type
SocketOk(c) == conn[c] # "revoked" /\ mode[c] = "interact"
\* clients.has(c) && !connectionOf(c).closing
Present(c) == conn[c] = "open"
\* input-guard.ts typingGuards.pendingLease, on a sighting taken now
FactsNow(c) == att /\ c \in members /\ ready
\* pending.ts authorizePending(owner, pane, lease), for the connection the lease was taken for
Authorized(c, l) ==
  /\ SocketOk(c) /\ Present(c)
  /\ l.k
  /\ ~held
  /\ att /\ l.a /\ l.p /\ c \in members /\ ready
\* pending.ts pendingLease(owner, pane) succeeds
CanLease(c) == SocketOk(c) /\ Present(c) /\ ~held /\ FactsNow(c)
\* whether a first message's failed lease check is one its page may try again (FIRST_MESSAGE_RETRY_CODES)
LeaseFailRetries(c, l) ==
  IF conn[c] = "revoked" THEN FALSE          \* device_revoked
  ELSE IF mode[c] # "interact" THEN TRUE     \* read_only
  ELSE IF ~Present(c) THEN TRUE              \* disconnected
  ELSE IF ~l.k THEN TRUE                     \* pending_lease_lost
  ELSE IF held THEN FALSE                    \* attach_held
  ELSE TRUE                                  \* input_not_ready

\* pending-input.ts next(pane), without the agent's status and the turn gate of statuses (see SKILL.md): of what holds
\* the queue for a turn, only the wait for an end the agent itself tells is here (turnWait)
Queued == SelectSeq(order, LAMBDA m : st[m] = "queued")
\* "review": uncertain, kept for review alone (pending-input.ts reviewOnly): it does not stop the queue (blocksQueue)
NextUp == IF (\E m \in Msgs : fl[m] \/ st[m] = "uncertain") \/ Queued = <<>> \/ (turnWait /\ ~BreakDrainBeforeTurnEnd)
            THEN "none" ELSE Head(Queued)
\* pending-input.ts claim(item, automatic)
CanClaim(m, automatic) ==
  /\ st[m] \notin Gone /\ ~fl[m] /\ st[m] \notin {"uncertain", "review"}
  /\ ~\E o \in Msgs : fl[o]
  /\ IF automatic THEN NextUp = m ELSE st[m] \in {"queued", "held"}
\* pending-input.ts hold(owner, pane) on the messages in `ms`
Hold(s, ms) == [m \in Msgs |-> IF m \in ms /\ (s[m] = "queued" \/ fl[m])
                                 THEN (IF fl[m] THEN "uncertain" ELSE "held") ELSE s[m]]
OwnedBy(S) == IF Sender \in S THEN {"Q"} ELSE {}

\* The connections in S lost the pane or the right to type. `left`: they are no longer attached to it.
Lose(S, left) ==
  /\ armed' = (armed /\ Sender \notin S)
  /\ pageOk' = (pageOk /\ ~(left /\ page \in S))
  /\ laneIntact' = (laneIntact /\ ~(lane.m # "none" /\ lane.by \in S))
  /\ reqIntact' = (reqIntact /\ ~(req.kind # "none" /\ req.c \in S))
NoLoss == UNCHANGED <<armed, pageOk, laneIntact, reqIntact>>

\* What the leases taken before answer after this step: the attachment closed, a new attach process started,
\* or the connections in S lost their authority (pendingAuthorities.delete)
Age(closed, restarted, S) ==
  LET aged(l, c) == [a |-> l.a /\ ~closed, p |-> l.p /\ ~closed /\ ~restarted, k |-> l.k /\ c \notin S]
  IN /\ lease' = aged(lease, Sender)
     /\ laneLease' = IF lane.m # "none" THEN aged(laneLease, lane.by) ELSE laneLease
     /\ reqLease' = IF req.kind # "none" THEN aged(reqLease, req.c) ELSE reqLease
Unauthorize(S) == IF BreakKeepAuthority THEN {} ELSE S

\* pending.ts holdPending(owner, pane) for each connection in S, with its holdRequested
HoldPending(S) ==
  /\ LET s1 == Hold(st, OwnedBy(S))
         leaves == requester \in S
     IN st' = [s1 EXCEPT !["F"] = IF leaves /\ ~BreakNoHoldOnLeave /\ ~fl["F"] /\ @ = "queued" THEN "held" ELSE @]
  /\ requester' = IF requester \in S /\ ~BreakKeepRequester THEN "none" ELSE requester
  /\ askLeft' = (askLeft \/ (st["F"] = "asked" /\ page \in S))

NoAttachment == att' = FALSE /\ alive' = FALSE /\ ready' = FALSE /\ held' = FALSE /\ members' = {}

Init ==
  /\ att = FALSE /\ alive = FALSE /\ ready = FALSE /\ held = FALSE /\ members = {}
  /\ conn = [c \in Clients |-> "open"] /\ mode = [c \in Clients |-> "interact"]
  \* workspace-routes.ts: a create request with a first message has come from a page (askFirstMessage), or none has.
  \* The pane is there from the start: what happens to it before the route learns which pane herdr made is kept
  \* (the request's `early`) and counted when the route names the pane (`at`), so askLeft and askFault are as if
  \* the pane had been known all along
  /\ \E asks \in BOOLEAN, asker \in Clients :
       /\ st = [m \in Msgs |-> IF m = "F" /\ asks THEN "asked" ELSE "none"]
       /\ page = IF asks THEN asker ELSE Sender
  /\ order = <<>> /\ requester = "none" /\ askLeft = FALSE /\ askFault = FALSE /\ pageOk = TRUE
  /\ fl = [m \in Msgs |-> FALSE]
  /\ lease = Dead /\ laneLease = Dead /\ reqLease = Dead
  /\ lane = NoLane /\ req = NoReq /\ turnWait = FALSE /\ toldTurn = FALSE
  /\ armed = FALSE /\ laneIntact = FALSE /\ reqIntact = FALSE
  /\ pastes = [m \in Msgs |-> 0] /\ enters = [m \in Msgs |-> 0]
  /\ typedAfterLoss = FALSE /\ firstWithoutPage = FALSE /\ behindTurn = FALSE

----------------------------------------------------------------------------
(* The terminal: terminals.ts terminalFrames.attach, detach, closeAttachment; *)
(* terminal-process.ts took, ended, again                                      *)

\* attach: the connection joins the pane's attachment, made first when there is none
Attach(c) ==
  /\ conn[c] = "open" /\ c \notin members
  /\ IF ~att
       THEN /\ att' = TRUE /\ alive' = TRUE /\ held' = FALSE
            /\ \E mirrored \in BOOLEAN : ready' = mirrored   \* a mirrored pane is ready at once
       ELSE UNCHANGED <<att, alive, held, ready>>
  /\ members' = members \cup {c}
  /\ UNCHANGED <<conn, mode, st, fl, leases, order, first, lane, req, counts, turnWait, toldTurn>>
  /\ NoLoss

\* detach(pane, client): holdPending, then the membership, then closeAttachment when it was the last
Leave(c) ==
  /\ HoldPending({c})
  /\ IF members = {c} THEN NoAttachment
     ELSE members' = members \ {c} /\ UNCHANGED <<att, alive, ready, held>>
  /\ Age(members = {c}, FALSE, Unauthorize({c}))

Detach(c) ==
  /\ conn[c] = "open" /\ c \in members
  /\ Leave(c)
  /\ UNCHANGED <<conn, mode, fl, order, page, askFault, lane, req, counts, turnWait, toldTurn>>
  /\ Lose({c}, TRUE)

\* closeAttachment: the pty or the mirror ended for good, the pane ended or moved, or the server stops
CloseAttachment ==
  /\ att
  /\ HoldPending(members)
  /\ NoAttachment
  /\ Age(TRUE, FALSE, Unauthorize(members))
  /\ UNCHANGED <<conn, mode, fl, order, page, askFault, lane, req, counts, turnWait, toldTurn>>
  /\ Lose(members, TRUE)

\* took(): the attach has the terminal
Took ==
  /\ att /\ alive /\ ~ready
  /\ ready' = TRUE /\ held' = FALSE
  /\ UNCHANGED <<att, alive, members, conn, mode, st, fl, leases, order, first, lane, req, counts, turnWait, toldTurn>>
  /\ NoLoss

\* ended(): the attach process exited; holdPendingPane when it was ready. Another bridge may have the terminal now.
Ended ==
  /\ att /\ alive
  /\ alive' = FALSE /\ ready' = FALSE
  /\ \E h \in {held, TRUE} : held' = h
  /\ IF ready
       THEN /\ st' = Hold(st, Msgs)
            /\ Age(FALSE, FALSE, {c \in Clients : conn[c] = "open"})
            /\ askFault' = (askFault \/ st["F"] = "asked")
       ELSE UNCHANGED <<st, leases, askFault>>
  /\ UNCHANGED <<att, members, conn, mode, fl, order, page, requester, askLeft, lane, req, counts, turnWait, toldTurn>>
  /\ Lose(members, FALSE)

\* again() or relookup(): a new attach process for the same attachment
Restart ==
  /\ att /\ ~alive /\ members # {}
  /\ alive' = TRUE
  /\ Age(FALSE, TRUE, {})
  /\ UNCHANGED <<att, ready, held, members, conn, mode, st, fl, order, first, lane, req, counts, turnWait, toldTurn>>
  /\ NoLoss

----------------------------------------------------------------------------
(* Connections: socket.ts role, close; connections.ts end *)

\* role observe: holdPending(client) for every pane, then the mode
Observe(c) ==
  /\ conn[c] = "open" /\ mode[c] = "interact"
  /\ HoldPending({c})
  /\ Age(FALSE, FALSE, Unauthorize({c}))
  /\ mode' = [mode EXCEPT ![c] = "observe"]
  /\ UNCHANGED <<terminal, conn, fl, order, page, askFault, lane, req, counts, turnWait, toldTurn>>
  /\ Lose({c}, TRUE)

Interact(c) ==
  /\ conn[c] = "open" /\ mode[c] = "observe"
  /\ mode' = [mode EXCEPT ![c] = "interact"]
  /\ UNCHANGED <<terminal, conn, st, fl, leases, order, first, lane, req, counts, turnWait, toldTurn>>
  /\ NoLoss

\* end(client, "closed" or "stalled"): closeConnection (pending.close and holdRequested), then detachClaimed
Close(c) ==
  /\ conn[c] \in {"open", "revoked"}
  /\ conn' = [conn EXCEPT ![c] = "closed"]
  /\ IF c \in members THEN Leave(c)
     ELSE /\ st' = [Hold(st, OwnedBy({c})) EXCEPT !["F"] =
                      IF requester = c /\ ~BreakNoHoldOnLeave /\ ~fl["F"] /\ @ = "queued" THEN "held" ELSE @]
          /\ requester' = IF requester = c /\ ~BreakKeepRequester THEN "none" ELSE requester
          /\ askLeft' = (askLeft \/ (st["F"] = "asked" /\ page = c))
          /\ UNCHANGED <<terminal, leases>>
  /\ mode' = [mode EXCEPT ![c] = "interact"]   \* nothing reads the mode of a connection that ended
  /\ UNCHANGED <<fl, order, page, askFault, lane, req, counts, turnWait, toldTurn>>
  /\ Lose({c}, TRUE)

\* end(client, "revoked" or "gated"): no closeConnection, only detachClaimed; its close event comes later (Close)
Revoke(c) ==
  /\ conn[c] = "open"
  /\ conn' = [conn EXCEPT ![c] = "revoked"]
  /\ IF c \in members THEN Leave(c)
     ELSE UNCHANGED <<st, requester, askLeft, terminal, leases>>
  /\ mode' = [mode EXCEPT ![c] = "interact"]
  /\ UNCHANGED <<fl, order, page, askFault, lane, req, counts, turnWait, toldTurn>>
  /\ Lose({c}, TRUE)

----------------------------------------------------------------------------
(* pending.ts queueFirstMessage, after the workspace was made and the agent launched: its lane task awaits herdr *)
(* (currentIdentity) and then lists the message. Held when its page is gone or left since the request (the      *)
(* request's `left`), or when the pane's terminal restarted since (its `fault`); else queued for that page       *)

FirstListed ==
  /\ st["F"] = "asked" /\ lane = NoLane
  /\ LET gone == ~Present(page) \/ (askLeft /\ ~BreakListAfterLeave)
     IN /\ st' = [st EXCEPT !["F"] = IF gone \/ askFault THEN "held" ELSE "queued"]
        /\ requester' = IF gone THEN "none" ELSE page
  /\ order' = Append(order, "F")
  /\ askLeft' = FALSE /\ askFault' = FALSE
  /\ UNCHANGED <<terminal, conn, mode, fl, leases, page, lane, req, counts, turnWait, toldTurn, armed, pageOk, laneIntact, reqIntact>>

----------------------------------------------------------------------------
(* Frames that take a lease when they arrive and then wait for the lane: *)
(* pending.ts pendingFrames.submit (queue, hold) and pending-action (steer) *)

TakeRequest(kind, m, c) ==
  /\ req = NoReq /\ CanLease(c)
  /\ req' = [kind |-> kind, m |-> m, c |-> c]
  /\ reqLease' = Fresh
  /\ reqIntact' = TRUE
  /\ UNCHANGED <<terminal, conn, mode, st, fl, lease, laneLease, order, first, lane, counts, turnWait, toldTurn, armed, pageOk, laneIntact>>

\* the sender queues Q for the agent's next turn, or holds it for its own Send now. A bound of the model: only
\* once the first message is listed, so that the time before it holds the pages' and the terminal's events alone
Submit(kind) == st["Q"] = "none" /\ st["F"] # "asked" /\ lane.m # "Q" /\ TakeRequest(kind, "Q", Sender)

\* Send now on a row: its own message, or the pane's first message from any attached connection
SendNow(m, c) ==
  /\ st[m] \notin Gone
  /\ (m = "Q" => c = Sender) /\ (m = "F" => c \in members)
  /\ TakeRequest("steer", m, c)

\* the frame's task starts in the lane and awaits pendingContext
RequestRuns ==
  /\ lane = NoLane /\ req # NoReq
  /\ lane' = [m |-> req.m, by |-> req.c, auto |-> FALSE, direct |-> FALSE,
              pc |-> IF req.kind = "steer" THEN "steer" ELSE req.kind, extra |-> FALSE, data |-> "untried"]
  /\ laneLease' = reqLease /\ reqLease' = Dead
  /\ req' = NoReq /\ laneIntact' = reqIntact /\ reqIntact' = FALSE
  /\ UNCHANGED <<terminal, conn, mode, st, fl, lease, order, first, counts, turnWait, toldTurn, armed, pageOk>>

\* pending.enqueue adds the record behind those there
Accepted == order' = Append(order, "Q")
Free == lane' = NoLane /\ laneLease' = Dead /\ laneIntact' = FALSE
Still == UNCHANGED <<terminal, conn, mode, first, req, reqLease, counts, turnWait, toldTurn, pageOk, reqIntact>>

\* pendingContext refused, the lease check among its reasons: nothing is accepted
AcceptRefused ==
  /\ lane.m # "none" /\ lane.pc \in {"queue", "hold"}
  /\ Free /\ Still /\ UNCHANGED <<st, fl, lease, order, armed>>

\* pending.enqueue, with the authorizePending right after it passing
AcceptEnqueue ==
  /\ lane.m # "none" /\ lane.pc \in {"queue", "hold"} /\ Authorized(lane.by, laneLease)
  /\ st' = [st EXCEPT !["Q"] = IF lane.pc = "queue" THEN "queued" ELSE "held"]
  /\ lease' = laneLease /\ Accepted
  /\ armed' = (lane.pc = "queue" /\ laneIntact)
  /\ Free /\ Still /\ UNCHANGED fl

\* pending.enqueue after the lease was lost during the awaits since pendingContext's check (pinPiSession, a send put
\* off): the authorizePending right after it refuses, and pending.hold holds the row, as holdPending would have
AcceptHeld ==
  /\ lane.m # "none" /\ lane.pc \in {"queue", "hold"} /\ ~Authorized(lane.by, laneLease)
  /\ st' = [st EXCEPT !["Q"] = "held"]
  /\ lease' = laneLease /\ Accepted
  /\ armed' = FALSE
  /\ Free /\ Still /\ UNCHANGED fl

\* a queue request that finds the agent ready and nothing waiting is typed at once, with no record
AcceptTypeNow ==
  /\ lane.m # "none" /\ lane.pc = "queue" /\ Authorized(lane.by, laneLease)
  /\ ~\E m \in Msgs : fl[m] \/ st[m] = "queued"
  /\ ~turnWait
  /\ lane' = [lane EXCEPT !.pc = "typing", !.direct = TRUE]
  /\ Still /\ UNCHANGED <<st, fl, lease, laneLease, order, armed, laneIntact>>

\* Send now refused before its claim; settled held when the row is the connection's own (pending-action, after resend)
SteerRefused ==
  /\ lane.m # "none" /\ lane.pc = "steer"
  /\ st' = IF lane.m = "Q" /\ CanClaim("Q", FALSE) THEN [st EXCEPT !["Q"] = "held"] ELSE st
  /\ Free /\ Still /\ UNCHANGED <<fl, lease, order, armed>>

\* pending.claim(item, false) right after pendingContext passed; a first message takes its lease here (dispatchPending)
SteerClaim ==
  /\ lane.m # "none" /\ lane.pc = "steer" /\ Authorized(lane.by, laneLease)
  /\ CanClaim(lane.m, FALSE)
  /\ st' = [st EXCEPT ![lane.m] = "sending"] /\ fl' = [fl EXCEPT ![lane.m] = TRUE]
  /\ lease' = IF lane.m = "Q" THEN laneLease ELSE lease
  /\ lane' = [lane EXCEPT !.pc = "typing"]
  /\ Still /\ UNCHANGED <<laneLease, order, armed, laneIntact>>

----------------------------------------------------------------------------
(* The queue: pending.ts drainPending, dispatchPending, dispatchPendingText *)

\* typists(pane): who could type a first message now
Typist(c) == Present(c) /\ SocketOk(c) /\ FactsNow(c)

\* drainPending's task: pending.next(pane) and who types it, then it awaits bindLaunched and awaitsOmp
DrainPick ==
  /\ lane = NoLane /\ NextUp # "none"
  /\ \E by \in Clients :
       /\ IF NextUp = "Q" THEN by = Sender ELSE requester = by /\ Typist(by)
       /\ lane' = [m |-> NextUp, by |-> by, auto |-> TRUE, direct |-> FALSE, pc |-> "picked", extra |-> FALSE, data |-> "untried"]
  /\ laneIntact' = FALSE
  /\ UNCHANGED <<terminal, conn, mode, st, fl, leases, order, first, req, counts, turnWait, toldTurn, armed, pageOk, reqIntact>>

\* pending.claim(item, true) fails: the message was held, sent or discarded meanwhile
DrainSkips ==
  /\ lane.m # "none" /\ lane.pc = "picked" /\ ~CanClaim(lane.m, TRUE)
  /\ Free /\ Still /\ UNCHANGED <<st, fl, lease, order, armed>>

\* dispatchPending: unattended, for a first message whose page is gone
Unattended == lane.auto /\ lane.m = "F" /\ (requester = "none" \/ ~Present(requester))

\* pending.claim(item, true), then dispatchPending's lease: the record's, or for a first message one taken now
DrainClaim ==
  /\ lane.m # "none" /\ lane.pc = "picked" /\ CanClaim(lane.m, TRUE)
  /\ lane.m = "F" => CanLease(lane.by)
  /\ st' = [st EXCEPT ![lane.m] = "sending"] /\ fl' = [fl EXCEPT ![lane.m] = TRUE]
  /\ lane' = [lane EXCEPT !.pc = "typing"]
  /\ laneLease' = IF lane.m = "Q" THEN lease ELSE Fresh
  /\ laneIntact' = (lane.m = "F")
  /\ UNCHANGED <<terminal, conn, mode, lease, reqLease, order, first, req, counts, turnWait, toldTurn, armed, pageOk, reqIntact>>

\* the same claim for a first message whose typist cannot take a lease any more: pendingLease throws and the
\* message is settled in the same step, queued again for its page or held
DrainClaimNoLease ==
  /\ lane.m = "F" /\ lane.pc = "picked" /\ CanClaim("F", TRUE) /\ ~CanLease(lane.by)
  /\ st' = [st EXCEPT !["F"] = IF (~att \/ LeaseFailRetries(lane.by, Fresh)) /\ ~Unattended THEN "queued" ELSE "held"]
  /\ Free /\ Still /\ UNCHANGED <<fl, lease, order, armed>>

\* dispatchPending's retry decision and pending-input.ts settle(item, fault, uncertain, retryWhenReady), and what a
\* send with no record leaves. A connection's message that hold() marked on its way is held, never queued again
Settle(outcome) ==
  LET m == lane.m
      again == outcome = "retry" /\ lane.auto /\ ~Unattended
                 /\ (BreakRequeueLostLease \/ ~(m = "Q" /\ st[m] = "uncertain"))
      new == IF lane.direct
               THEN (IF outcome = "sent" THEN "sent" ELSE IF outcome = "uncertain" THEN "lost" ELSE "none")
               ELSE (IF outcome \in {"sent", "uncertain", "review"} THEN outcome ELSE IF again THEN "queued" ELSE "held")
      s1 == [st EXCEPT ![m] = new]
  IN /\ st' = IF outcome = "uncertain" /\ ~lane.direct THEN Hold(s1, Msgs \ {m}) ELSE s1
     /\ fl' = [fl EXCEPT ![m] = FALSE]
     /\ Free

Typing == lane.m # "none" /\ lane.pc = "typing"
Quiet == UNCHANGED <<terminal, conn, mode, lease, reqLease, order, first, req, counts, turnWait, toldTurn, armed, pageOk, reqIntact>>

\* agent_blocked or pending_wait before anything was typed. agent_blocked is thrown inside pendingContext, after its
\* awaits and before its last authorizePending; a queue request typed at once is kept only on pending_wait, which
\* follows an authorizePending with no await between (TypeNowWaits)
RefusedForNow ==
  /\ Typing /\ ~lane.direct
  /\ Settle("retry") /\ Quiet

TypeNowWaits ==
  /\ Typing /\ lane.direct /\ Authorized(lane.by, laneLease)
  /\ st' = [st EXCEPT !["Q"] = "queued"] /\ lease' = laneLease /\ Accepted
  /\ armed' = laneIntact
  /\ Free
  /\ UNCHANGED <<terminal, conn, mode, fl, reqLease, first, req, counts, turnWait, toldTurn, pageOk, reqIntact>>

\* any other refusal before anything was typed: the target changed, a draft in the box, the deadline
RefusedForGood ==
  /\ Typing
  /\ Settle("held") /\ Quiet

\* a refusal before anything was typed that holds every message of the pane with it: Codex's own screen (unannounced)
\* on an automatic send, or Codex's app server reporting changed loaded threads on a Send now
RefusedHoldPane ==
  /\ Typing
  /\ LET s1 == [st EXCEPT ![lane.m] = IF lane.direct THEN "none" ELSE "held"]
     IN st' = Hold(s1, Msgs \ {lane.m})
  /\ fl' = [fl EXCEPT ![lane.m] = FALSE]
  /\ Free /\ Quiet

\* authorizePending threw before the paste, or the paste's guard answered false before the first byte
LeaseFailed ==
  /\ Typing /\ ~Authorized(lane.by, laneLease)
  /\ Settle(IF lane.m = "F" /\ LeaseFailRetries(lane.by, laneLease) THEN "retry" ELSE "held") /\ Quiet

\* what a write is checked against: the sender, or who asked for this send, has not left since
WriteRight == IF lane.auto /\ lane.m = "Q" THEN armed ELSE laneIntact
PageRight == lane.auto /\ lane.m = "F" => pageOk /\ lane.by = page
Write ==
  /\ typedAfterLoss' = (typedAfterLoss \/ ~WriteRight)
  /\ firstWithoutPage' = (firstWithoutPage \/ ~PageRight)
  /\ behindTurn' = (behindTurn \/ (toldTurn /\ (lane.auto \/ lane.direct)))
Wrote == UNCHANGED <<terminal, conn, mode, st, fl, leases, order, first, req, turnWait, toldTurn, armed, pageOk, laneIntact, reqIntact>>

\* paneSendText with the guard `allowed`: the lease is asked at the write
Paste ==
  /\ Typing /\ Authorized(lane.by, laneLease)
  /\ pastes' = [pastes EXCEPT ![lane.m] = Min(@ + 1, 2)]
  /\ lane' = [lane EXCEPT !.pc = "pasted"]
  /\ Write /\ Wrote /\ UNCHANGED enters

\* The agent's data channel is asked before anything is typed, once per send: ACP `child.client.submit`, Codex's
\* app-server `turn/steer` (`writing`) or `turn/start` (sendCodexTextAsData `mayWrite`). It took nothing (no
\* connection, another thread loaded, a question waiting): the message is typed as before
DataUnsent ==
  /\ Typing /\ lane.data = "untried"
  /\ lane' = [lane EXCEPT !.data = "unsent"]
  /\ UNCHANGED <<terminal, conn, mode, st, fl, leases, order, first, req, turnWait, toldTurn, armed, pageOk, laneIntact, reqIntact, counts>>

\* The message goes as data, in one step with `authorizePending` right before the socket write. It counts as its paste
\* and its Enter: once it went, nothing of it is typed
SubmitAsData ==
  /\ Typing /\ lane.data = "untried" /\ Authorized(lane.by, laneLease)
  /\ pastes' = [pastes EXCEPT ![lane.m] = Min(@ + 1, 2)]
  /\ enters' = [enters EXCEPT ![lane.m] = Min(@ + 1, 2)]
  /\ lane' = [lane EXCEPT !.pc = "entered", !.data = "sent"]
  /\ Write /\ Wrote

\* Codex's own server says its thread runs a turn, before anything went (Connection.startTurn "running"): the queue's
\* send goes behind that turn's own end (pending.awaitTurn) and is put off; a queue request that was to be typed at once
\* is listed, with the authorizePending right after pending.enqueue as in AcceptEnqueue and AcceptHeld. A Send now is the
\* user's own: it is typed as before (DataUnsent)
DataBusy ==
  /\ Typing /\ lane.data = "untried" /\ (lane.auto \/ lane.direct)
  /\ turnWait' = TRUE /\ toldTurn' = TRUE
  /\ IF lane.direct
       THEN /\ st' = [st EXCEPT !["Q"] = IF Authorized(lane.by, laneLease) THEN "queued" ELSE "held"]
            /\ lease' = laneLease /\ Accepted
            /\ armed' = (Authorized(lane.by, laneLease) /\ laneIntact)
            /\ Free /\ UNCHANGED fl
       ELSE Settle("retry") /\ UNCHANGED <<lease, order, armed>>
  /\ UNCHANGED <<terminal, conn, mode, reqLease, first, req, counts, pageOk, reqIntact>>

\* anything that fails after the paste (a check, the lease, herdr): submit_changed or pasted_not_sent, never tried again
FailedAfterPaste ==
  /\ lane.m # "none" /\ lane.pc \in {"pasted", "entered"}
  /\ Settle(IF BreakRetryAfterTyping /\ lane.pc = "pasted" /\ ~lane.direct THEN "retry" ELSE "uncertain") /\ Quiet

\* paneSendKeys Enter with the guard `allowed`
Enter ==
  /\ lane.m # "none" /\ lane.pc = "pasted" /\ Authorized(lane.by, laneLease)
  /\ enters' = [enters EXCEPT ![lane.m] = Min(@ + 1, 2)]
  /\ lane' = [lane EXCEPT !.pc = "entered"]
  /\ Write /\ Wrote /\ UNCHANGED pastes

\* a Send now's later key with the same guard: Codex's Escape (interruptCodexSteering), Grok's second Enter
LaterKey ==
  /\ lane.m # "none" /\ lane.pc = "entered" /\ ~lane.auto /\ ~lane.direct /\ ~lane.extra
  /\ Authorized(lane.by, laneLease)
  /\ lane' = [lane EXCEPT !.extra = TRUE]
  /\ Write /\ Wrote /\ UNCHANGED <<pastes, enters>>

Sent ==
  /\ lane.m # "none" /\ lane.pc = "entered"
  /\ Settle("sent") /\ Quiet

\* turn/start answered with the turn the message became (Connection.startTurn "started"): the queue waits for that
\* turn's own end (pending.awaitTurn) from the step that settles the message sent
SentAsTurn ==
  /\ lane.m # "none" /\ lane.pc = "entered" /\ lane.data = "sent"
  /\ Settle("sent") /\ toldTurn' = TRUE /\ turnWait' = ~BreakNoWaitForTurn
  /\ UNCHANGED <<terminal, conn, mode, lease, reqLease, order, first, req, counts, armed, pageOk, reqIntact>>

\* The data channel did not answer a request that went (startTurn or steer "unknown"): submit_changed. The message is
\* kept uncertain and is never typed instead, as one that reached nothing is
DataUnanswered ==
  /\ lane.m # "none" /\ lane.pc = "entered" /\ lane.data = "sent"
  /\ IF BreakTypeUnansweredData
       THEN lane' = [lane EXCEPT !.pc = "typing", !.data = "unsent"] /\ UNCHANGED <<st, fl, laneLease, laneIntact>>
       ELSE Settle("uncertain")
  /\ Quiet

\* The agent told the awaited turn's end (turn/completed for that turn), or can no longer tell it (its connection
\* ended, the pane runs another thread): pending.turnOver. The queue goes on, by the agent's status again
TurnOver ==
  /\ turnWait \/ toldTurn
  /\ turnWait' = FALSE /\ toldTurn' = FALSE
  /\ UNCHANGED <<terminal, conn, mode, st, fl, leases, order, first, lane, req, armed, pageOk, laneIntact, reqIntact, counts>>

\* a Codex Send now on the terminal whose Enter went, with nothing that proves Codex took this message (codex-steering.ts
\* "unconfirmed", pending.ts keepTurnGate): settle(…, "preserve-turn") keeps it uncertain for review alone, and holds
\* nothing else
SentUnconfirmed ==
  /\ lane.m # "none" /\ lane.pc = "entered" /\ ~lane.auto /\ ~lane.direct
  /\ Settle("review") /\ Quiet

\* every connection has closed and nothing runs: the end
Over ==
  /\ \A c \in Clients : conn[c] = "closed"
  /\ lane = NoLane
  /\ UNCHANGED vars

Next ==
  \/ \E c \in Clients : Attach(c) \/ Detach(c) \/ Observe(c) \/ Interact(c) \/ Close(c) \/ Revoke(c)
  \/ CloseAttachment \/ Took \/ Ended \/ Restart
  \/ \E kind \in {"queue", "hold"} : Submit(kind)
  \/ \E m \in Msgs, c \in Clients : SendNow(m, c)
  \/ FirstListed \/ RequestRuns \/ AcceptRefused \/ AcceptEnqueue \/ AcceptHeld \/ AcceptTypeNow \/ SteerRefused \/ SteerClaim
  \/ DrainPick \/ DrainSkips \/ DrainClaim \/ DrainClaimNoLease
  \/ RefusedForNow \/ TypeNowWaits \/ RefusedForGood \/ RefusedHoldPane \/ LeaseFailed
  \/ Paste \/ DataUnsent \/ SubmitAsData \/ DataBusy \/ FailedAfterPaste \/ DataUnanswered \/ Enter \/ LaterKey
  \/ Sent \/ SentAsTurn \/ SentUnconfirmed \/ TurnOver
  \/ Over

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* The rules *)

\* Nothing of a message is typed after the connection it waits on left the pane, closed, started to watch or lost the attach.
NoTypingAfterLeaseLoss == ~typedAfterLoss
\* A first message is typed on its own only through the page that asked for it, and never once that page has left
\* since its request came.
FirstMessageOnlyByItsPage == ~firstWithoutPage
\* A message is pasted once and gets one Enter, whatever fails. One that went as data has had both: it is never typed
\* as well, also when no answer to it came.
TypedAtMostOnce == \A m \in Msgs : pastes[m] <= 1 /\ enters[m] <= 1
\* A first message whose page left is held, so the pane's queue is not stuck behind it.
FirstMessageHeldOncePageLeft == st["F"] = "queued" => pageOk \/ conn[page] = "revoked"
\* A queued message whose sender left is held: its row never says it still waits for the agent's turn.
LostLeaseStaysHeld == st["Q"] = "queued" => armed
\* While the queue waits for a turn's end the agent itself tells, it types nothing on its own: no queued message, and
\* none sent to the queue and typed at once. A Send now is the user's own.
QueueWaitsForToldTurnEnd == ~behindTurn

=============================================================================
