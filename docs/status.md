# Observer status

Phoebe exposes a small, read-only interface for local dashboards and monitoring
tools:

```bash
docker exec <phoebe-container> phoebe status --json
```

The command never starts work, changes configuration, or talks to GitHub. It
reads the latest engine snapshot from `paths.stateDir` and prints one JSON
envelope. A snapshot that is missing or unreadable is still represented as JSON,
so callers do not need to parse stderr to distinguish startup from corruption.

## Discovery

The scaffolded Compose service opts into discovery with two labels:

```yaml
org.jesusfilm.phoebe.role: agent
org.jesusfilm.phoebe.observer-version: "1"
```

An observer lists containers carrying `org.jesusfilm.phoebe.role=agent`, checks
the protocol label, then runs `phoebe status --json` inside each container. Repo
identity deliberately does not live in a label: `repoSlug` comes from the
resolved `phoebe.config.ts`, avoiding a second value that can drift.

Labels are an opt-in discovery hint, not an authorization mechanism. Access to
the Docker daemon is already privileged; protect it accordingly.

## Envelope

Every invocation writes an envelope with observer schema version `1` and the
time the command made the observation:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-07-29T12:00:15.000Z",
  "available": true,
  "status": {}
}
```

Before the engine has written a snapshot, or when the file cannot be decoded,
`available` is `false` with a stable `reason` (`not-found` or `unreadable`) and
a human-readable `message`.

`observedAt` answers “when did the observer successfully reach this container?”
`status.updatedAt` answers “when did the engine last change observable state?”
An idle or long-running engine may legitimately have an old `updatedAt`; that is
not evidence the container is unreachable.

## Status snapshot

The `status` object contains:

| Field           | Meaning                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `schemaVersion` | Snapshot schema version (`1`).                                                              |
| `updatedAt`     | Time of the latest recorded state transition.                                               |
| `startedAt`     | Start time of this engine process.                                                          |
| `repoSlug`      | Effective GitHub `owner/repo`.                                                              |
| `phase`         | `starting`, `selecting`, `idle`, `running`, `draining`, `stopped`, or `failed`.             |
| `engine`        | Source (`github`, `local`, or direct), ref/repo, running SHA, and optional quarantined SHA. |
| `configuration` | Effective, non-secret operational configuration for drift detection.                        |
| `currentWork`   | Current work kind, description, issue/PR/branch identity, and start time.                   |
| `idleReason`    | Why the last selection produced no workable unit.                                           |
| `lastOutcome`   | Latest completed or failed engine work call.                                                |
| `recentEvents`  | The latest 20 summarized lifecycle events, oldest to newest.                                |

`completed` means the work-kind runner returned normally. It does not claim that
the resulting PR merged or that every downstream GitHub check passed; GitHub
remains the durable workflow record.

The configuration projection intentionally excludes commands, prompt contents,
environment variables, token names, and secrets. It includes the fields useful
for comparing a fleet: branch/label policy, PR scope, work order, provider,
model, and poll interval.

## Persistence and safety

The engine writes `observer-status.json` under `paths.stateDir` using a temporary
file plus an atomic rename. Readers therefore see either the previous complete
snapshot or the next complete snapshot, never a partially-written document.
Write failures are logged but do not stop the worker.

Error summaries are flattened, bounded to 2,000 characters, and redact:

- the active GitHub/provider secret values,
- common token environment assignments,
- bearer credentials, and
- `x-access-token` credentials embedded in Git URLs.

The status interface is not a log transport. Full agent output remains in the
container logs and is never copied into the snapshot.

The recent event list is bounded and operational only. GitHub issues, pull
requests, checks, and review threads remain the permanent history.
