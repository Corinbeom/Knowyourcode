# AGENTS.md

## Project

KnowYourCode is an AI code-understanding test service.
It analyzes public GitHub repositories and commits, generates code-grounded questions, and evaluates user answers.

## Rules

- Do not commit unless the user explicitly asks.
- Do not revert user changes unless explicitly asked.
- Keep changes scoped to the requested task.
- Run relevant checks before reporting completion.
- Never commit secrets, API keys, `.env.local`, raw user repo data, or LLM response logs.
- Prefer Korean UI copy because the primary target users are Korean.
- Use concise Korean/English mixed commit messages with prefixes such as `feat:`, `fix:`, `refactor:`, and `chore:`.

## Git Workflow

- `main` is the production branch. Do not implement directly on `main`.
- `develop` is the integration branch for the next release.
- Create task branches from `develop`.
  - `feat/<short-name>` for product changes
  - `fix/<short-name>` for bug fixes
  - `chore/<short-name>` for maintenance
- Keep commits small and scoped.
- Do not push directly to `main` unless the user explicitly asks.

## Current Stack

- Web: Next.js App Router, React, TypeScript
- API: FastAPI under `apps/api`
- Web API routes proxy to FastAPI where `BACKEND_API_URL` is configured.

## Future Monorepo Notes

When the project is split into `apps/web` and `apps/api`, follow the nearest `AGENTS.md` first.

Expected structure:

```txt
apps/
  web/
    AGENTS.md
  api/
    AGENTS.md
```
