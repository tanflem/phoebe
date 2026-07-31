---
"phoebe-agent": minor
---

Add `phoebe setup`, an interactive one-stop wizard that scaffolds the consumer
runtime (like `phoebe init`) and then walks you through a short Q&A to write a
complete `phoebe.config.ts` and a filled `.env` — detecting the repo from your
git remote, picking the agent provider, and masking secret input — so you can go
straight to `docker compose build` with no hand-editing. `phoebe init` stays the
bare, non-interactive scaffolding primitive.
