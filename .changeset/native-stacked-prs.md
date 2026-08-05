---
"phoebe-agent": minor
---

Add `stackMode` config field (`PHOEBE_STACK_MODE` overlay). `"banner"`
(default, unchanged behavior) keeps basing a blocked issue's PR on
`defaultBranch` with a ⛓️ "do not merge before the blocker" banner. `"native"`
instead opens the PR against the blocker's branch and registers it as a true
GitHub stacked PR via `gh stack link` (the `github/gh-stack` extension, installed
lazily on first boot under native mode). `"off"` never stacks, though a blocker
still gates the skip decision.
