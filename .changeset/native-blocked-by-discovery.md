---
"phoebe-agent": minor
---

Add `blockerSource` config field (`PHOEBE_BLOCKER_SOURCE` overlay). `"body"`
(default, unchanged behavior) parses `blockedByPattern` over the issue body
text; `"native"` reads GitHub's issue-dependencies API
(`repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by`) instead; `"both"`
unions and deduplicates the two.
