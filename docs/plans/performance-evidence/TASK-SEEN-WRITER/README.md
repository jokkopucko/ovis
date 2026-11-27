# TASK-003: Seen serialized writer evidence

Base: `1d71a718db4e0318c2d7d3f3a80c3e8c939e36c1`. Synthetic data only; no production impact claim.

## Design and limits

- One serialized lane per SeenStore with group commit: everything that arrives while a write runs goes into the next single file replacement, so a backlog costs at most two writes. At most MAX_SEEN (500) accepted browser acknowledgements, including the in-flight batch; an excess acknowledgement gets 503 `seen_busy`, which the browser retries. One-shot pane moves use the same ordering, but cannot be retried, so they are not rejected when a backlog accumulates. Identical/older updates reach the head and skip persistence.
- Stage from the last committed map, await private temporary-file write/fsync/atomic rename, then replace memory and publish. Failed operations do not poison the lane or contribute to a later merge.
- Damaged bytes are copied privately and synced before replacing `.bad`; the original stays in place until the final atomic rename. Generic synchronous `writeStateDocument` is unchanged.
- `close()` rejects new work, drains accepted operations and waits for what listeners started for them (herdr-core's `herdr.seen` label). ServerInstance.stop returns that drain; SSH shutdown keeps ownership until the drain finishes or its ten-second exit deadline is reached. Local and remote move callbacks catch async errors. The managed launcher forwards signals to the child, which owns its drain and stops waiting for it after 4 s (the supervisor kills at 6 s). A machine bridge still starting is aborted at stop instead of waiting for its 30 s start deadline.
- JSON schema, success payloads and events are unchanged. Saturation answers 503 `seen_busy` (additive; clients already retry 5xx from 502 up). File reading on initialization/first effective update and JSON/map work remain synchronous. Multiple independent owners of the same stateDir remain unsupported.

## Reproduction

```sh
mkdir -p "$HOME/.cache/ovis-tmp/seen-writer"
TMPDIR="$HOME/.cache/ovis-tmp/seen-writer" bun scripts/seen-writer-benchmark.ts > docs/plans/performance-evidence/TASK-SEEN-WRITER/results.json
TMPDIR="$HOME/.cache/ovis-tmp/seen-writer" bun test server/seen.test.ts server/seen-writer.test.ts server/core/status.test.ts server/conventions.test.ts
```

`results.json` includes all five repetitions, Bun/OS/architecture, counts, elapsed times and raw event-loop gap samples. No warmups. The sync control reproduces the original map-copy/whole-file-replace/map-rebuild algorithm using the unchanged sync helper. The async modes exercise SeenStore. The slow variant inserts an event-loop turn per persistence; the unit fixture is stronger: it holds persistence on an explicitly released barrier while unrelated work runs. Timing is distribution-only, never a pass threshold.

| Answer chars | Mode | Writes / batch | Bytes / batch | Median elapsed ms | Median maximum event-loop gap ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 128 | sync baseline | 50 | 4744642 | 61.771 | 61.759 |
| 128 | async | 2 | 189785 | 6.327 | 2.546 |
| 128 | slow async | 2 | 189785 | 4.818 | 1.167 |
| 2048 | sync baseline | 50 | 52744642 | 104.911 | 104.907 |
| 2048 | async | 2 | 2109785 | 9.820 | 3.429 |
| 2048 | slow async | 2 | 2109785 | 8.602 | 3.333 |

Group commit yields during persistence and cuts write amplification: the 49 receipts that wait behind the first write go into one more. Measured on a loaded host (other checks running), so absolute times are noisy. These host measurements are not comparable to the historical Linux audit as a speedup ratio.

## Validation

- RED: new durable-publish/drain barrier test timed out on the synchronous implementation because it never entered the injected writer.
- GREEN: 226 tests / 1004 assertions across Seen, writer, core status and server conventions passed. Covers ordered increasing/older/equal IDs, restart, bounds, failed-first-write recovery, pane moves, MAX_SEEN eviction, schema/malformed/unreadable documents, damaged-copy/final-rename failure, and private modes.
- `bun run check fast` was run: generated types/themes, typecheck and build passed; unit lane failed (24231 pass, 148 fail, 655 skip). Failures span unrelated platform/shell/fixture suites; do not claim a green gate. `scripts/conventions.test.ts` rerun reproduces a pre-existing fixed-wait ratchet failure in untouched `scripts/relay-new-pc-press-regression.ts:180`.
- Final gate result and any further checks are recorded in the PR. Browser/integration/native Windows/container hook lanes have not been run locally. No UI change or live herdr session was used.
