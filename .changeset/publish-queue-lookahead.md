---
"phoebe-agent": minor
---

Bump the runtime status contract to `status-v2` and publish the resolved
`issues` work-order lookahead as `queue` — each eligible issue in selection
order with its fully resolved blocker set and whether it is workable this
cycle. `phoebe status --json` and `phoebe list` both surface it; a `status-v1`
reader gets an explicit `ContractCapabilityError` instead of a malformed parse.
