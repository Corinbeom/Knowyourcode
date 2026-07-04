# apps/api AGENTS.md

## Scope

This app will contain the KnowYourCode analysis API.

- FastAPI
- Python
- Future OCI deployment target

## Rules

- Keep API responses JSON-only and stable for `apps/web`.
- Keep secrets in environment variables only.
- Do not log API keys, raw user repository contents, or full LLM responses.
- Start migrations with small endpoints first, such as `/health` and Commit Mode analysis.
- Preserve prompt-injection protections when moving LLM logic from web to API.
- Prefer explicit request and response schemas when adding production endpoints.
