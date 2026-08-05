# Runtime status and work outcomes

Phoebe owns two local, versioned interfaces in `paths.stateDir`:

```text
status-v2.json
runtime-id
events-v1/
  events-00000000000000000001-00000000000000000100.jsonl
  events-00000000000000000101-open.jsonl
  quarantine/
```

They are repo-runtime interfaces, not Fleet or Helm interfaces. Phoebe selects
and completes work without either system running. Status and outcome writes
happen locally; no optional observer delivery is in the work loop.

## Snapshot

`status-v2.json` is replaced with a temporary-file rename, so a reader sees the
previous complete projection or the next complete projection. It carries the
runtime and repository identity, engine/bootstrap/config/policy/prompt/provider
digests, capabilities, lifecycle and active work, the resolved `queue`
lookahead, last success/failure, retry, backoff, quarantine and drain controls,
telemetry health, journal bounds, and authoritative GitHub links.

`queue` is every eligible `issues`-kind ticket in the order Phoebe would take
it, each with its fully resolved `blockedBy` set (body + native blockers merged
per `config.blockerSource`, not just the first one) and whether it is
`workable` this cycle — the same gate `resolveWorktreeBase` applies before
picking a unit. It answers "what comes after `activeWork`" without re-deriving
the dependency graph against GitHub.

The runtime ID is generated once in `runtime-id` and survives process and
container restarts. `PHOEBE_RUNTIME_ID` can supply it on the first start; a later
value that conflicts with the persisted identity is rejected rather than
silently changing the event namespace.

Read the exact projection without starting work or contacting GitHub:

```bash
phoebe status --json
```

Missing and corrupt snapshots produce a JSON error object. An unsupported major
version produces `unsupported-schema-major`, names both versions, and exits 2.

## Outcome journal

Each JSONL record is an `events-v1` normalized Work Outcome. Sequence numbers
increase monotonically inside one runtime state volume. Event IDs are stable,
and replay de-duplicates by `(runtimeId, eventId)`.

Segments rotate before the 101st event by default. Phoebe retains 20 segments,
deleting the oldest closed segment first. Segment names are zero-padded and
derived only from their sequence bounds, making rotation deterministic. Replay
reports:

- earliest and latest retained sequence;
- exact gaps after the consumer's requested sequence;
- retained segment count;
- quarantined tail count; and
- ignored duplicate count.

An incomplete or invalid tail is copied to `events-v1/quarantine/` under a
content-addressed name, then removed from the live segment. Earlier complete
events remain replayable. A syntactically complete record with `events-v2` is
not treated as corruption: it produces an explicit capability error.

## Compatibility and confidentiality

Schemas and compatibility fixtures ship in [`contracts/`](../contracts/).
Consumers must ignore additive fields and reject unsupported major versions.
The fixture corpus covers idle, running, success, verification failure, agent
failure, quota/backoff, graceful drain, crash-loop fallback, a corrupt tail, a
missing range, an unsupported major, an empty queue, a linear blocker chain,
and a diamond (one issue with two blockers).

The interfaces exclude secrets, prompt bodies, source code, and agent logs.
Failure and resource summaries are redacted and bounded. Digests are SHA-256
over canonicalized inputs; prompt bodies influence only the prompt digest.

If a journal write fails while the snapshot remains writable, snapshot health
becomes `degraded` and the work loop continues. Failure to initialize the
runtime identity means the safety-critical state volume itself is unavailable,
so startup fails instead of running without a stable event namespace.

Run the end-to-end contract check with:

```bash
pnpm run test:status-contract:container
```

It launches a network-disabled container, runs the real Phoebe CLI once against
an isolated local Git origin and fake `gh`/agent boundaries, then verifies the
snapshot, journal, PR linkage, and read-only CLI projection.

## Relationship to `codex/observer-status`

This implementation is based on `fork/main`, not on
`codex/observer-status`. It selectively keeps that branch's useful direction:
atomic snapshot replacement, telemetry redaction, a read-only status CLI, and
bootstrap provenance/lifecycle wiring. It supersedes the branch's
`observer-status.json`, ad hoc recent-events array, and discovery labels with
the published `status-v1` snapshot, `events-v1` segmented journal, schemas,
fixtures, replay/range behavior, rotation, and corruption quarantine. No commit
from `codex/observer-status` was merged or cherry-picked.
