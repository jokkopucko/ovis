# Relay mux flight and memory limits

Ovis Mux v1 has two independent limits: DATA credit, returned when the consumer
reads a body or accepts a complete WS message, and protected-wire flight,
released only by an authenticated cumulative RECEIVED. A successful local send
does not release either limit.

These are pre-release v1 policy changes. Both endpoints use
`shared/relay-mux-engine.ts`; WELCOME validates the fixed HTTP window from
`shared/relay-mux.ts`. An old WELCOME window is refused as `protocol_error`,
not silently interpreted with new credit. No deployed protocol is migrated.

| Limit | Per direction |
| --- | ---: |
| HTTP DATA credit per stream | 320 KiB |
| WS DATA credit / maximum message | 1 MiB |
| Plaintext frame / HTTP DATA payload | 16,384 / 16,376 bytes |
| Bulk protected-wire flight, across streams | 384 KiB |
| Ordinary flight, including bulk | 408 KiB |
| Control flight | 16 KiB |
| Combined non-RECEIVED flight | 424 KiB |
| Aggregate inbound reservations per endpoint | 12 MiB |

The 24 KiB difference between ordinary and bulk flight remains reserved for
interactive traffic, large enough for one maximum binary or base64 record plus
supported routing overhead. The scheduler still chooses four interactive frames
per bulk turn, round-robins within each class, and rechecks after every frame.
Control gets at most eight consecutive turns when ordinary work is eligible.
RECEIVED bypasses flight credit and is coalesced, preventing receipt deadlock.

## Why these values

At 50 ms RTT, 5 decimal MB/s needs at least 250,000 bytes in flight before
serialization and protocol costs. The former bulk allowance admitted only one
16,408-byte protected binary record. Raising only that allowance would leave
the former HTTP-credit limit as the next bottleneck.

A 384 KiB bulk allowance fits 23 full binary records or 17 base64 records.
A 320 KiB HTTP window fits 20 full DATA payloads. The deterministic 100 Mbit/s
FIFO benchmark delivers a 64 MiB response at 6.365 MB/s in binary and 5.358 MB/s
with base64 wire costs at 50 ms RTT. Terminal echo p95 is respectively 1.024x
and 1.032x idle. We keep the 16 KiB frame size: larger records would increase
the time before the scheduler can select interactive traffic.

The window is not a universal latency promise. Already submitted bulk records
cannot be preempted on an ordered carrier. The aggregate bulk serialization bound
is `393216 / link_bytes_per_second`: 31.46 ms at 100 Mbit/s, but 12 seconds at
32 KiB/s. With a zero-propagation-RTT link, an idle tiny echo takes almost no
time; a 1.5x ratio is not achievable by a saturated FIFO with bulk ahead of it.
The benchmark reports that case rather than hiding it with an idle-latency floor.
The acceptance ratio applies at 50 ms RTT on the specified 100 Mbit/s link.

## Bounded storage and malicious peers

Every stream reserves its receive window before admission. Both roles refuse a
stream that would exceed 12 MiB, even if the peer ignores the advertised stream
counts. Thirty-two HTTP streams fit (10 MiB); with eight WS streams, twelve HTTP
streams fit (11.75 MiB), and another HTTP stream is refused before dispatch.
Reservations remain charged during asynchronous cleanup. A WS rejection changes
its 1 MiB reservation to the smaller HTTP reservation.

The shell queues up to 64 HTTP requests when local stream admission is full.
Requests resume in order after a stream retires and releases its reservation.
Waiting longer than 30 seconds, exceeding the queue bound, losing the carrier,
or closing the transport fails the request explicitly; caller cancellation removes
it immediately. Queued requests never cross a reconnect. Pane attachments share
one WS per visited PC, not one per pane, but media-heavy Markdown can still exhaust
the remaining HTTP slots.

Inbound DATA above granted credit is `SESSION_ERROR flow_control_error` followed
by carrier close 4000 on both client and server. Excess admissions use RESET
`refused`; outgoing producer/metadata overruns retain `resource_exhausted`.
The frame cap, frame/open token buckets, request ceiling, and WS-message ceiling
remain enforced independently.

Each HTTP inbound queue is at most 320 KiB; each WS inbound payload is at most
1 MiB. Outgoing payload is at most 4 MiB across streams, with nonterminal streams
sharing at most 3 MiB. Metadata is at most 1 MiB and queued control is at most
64 KiB. Even double-counting inbound reservations and their admitted payload,
the mux accounting bound per endpoint/channel is:

```text
2 * 12 MiB + 4 MiB + 1 MiB + 64 KiB + 424 KiB
= 30,908,416 bytes = 29.4765625 MiB < 32 MiB
```

The server adapter charges source chunks against the remaining 32 MiB session
budget. As in the original mux contract, this bounds counted payload/queues,
not JavaScript heap overhead, retained backing stores, crypto scratch, browser
socket buffers, or whole-file blobs owned by the application.

## Reproduce

```sh
# Discrete-event clock; no wall-clock sleeps. All 0/20/50/100 ms RTT rows.
bun scripts/relay-mux-benchmark.ts
bun scripts/relay-mux-benchmark.ts --base64

# Separate real-clock run of the same FIFO model; timers and host load affect it.
timeout 1200 bun scripts/relay-mux-benchmark.ts --real

# Deterministic acceptance and original credit/fairness/isolation/deadlock tests.
bun test shared/relay-mux-throughput.test.ts shared/relay-mux-engine.test.ts
```

The carrier accepts sends immediately, then serializes protected-wire byte costs
at 100 Mbit/s and injects half the RTT in each direction. Echoes are offered every
37 ms independently of replies, avoiding coordinated omission. The run checks
every byte of the 64 MiB body and records peak accounting. It exercises real mux
engines, not a formula standing in for the scheduler. Encryption CPU, relay
hosting, and physical WebSocket framing are outside this performance model;
the separate relay e2e exercises the real encrypted path.
